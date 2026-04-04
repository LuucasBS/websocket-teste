package com.seuprojeto.chat.application.chat;

import com.seuprojeto.chat.domain.conversation.Conversation;
import com.seuprojeto.chat.domain.conversation.ConversationId;
import com.seuprojeto.chat.domain.conversation.ConversationRepository;
import com.seuprojeto.chat.domain.event.EventPublisher;
import com.seuprojeto.chat.domain.event.MessageSentEvent;
import com.seuprojeto.chat.domain.message.ChatMessage;
import com.seuprojeto.chat.domain.message.MessageId;
import com.seuprojeto.chat.domain.message.MessageRepository;
import com.seuprojeto.chat.domain.user.UserId;
import java.time.Instant;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ChatApplicationService implements SendMessageUseCase, LoadHistoryUseCase {

    private final ConversationRepository conversationRepository;
    private final MessageRepository messageRepository;
    private final EventPublisher eventPublisher;

    public ChatApplicationService(
        ConversationRepository conversationRepository,
        MessageRepository messageRepository,
        EventPublisher eventPublisher
    ) {
        this.conversationRepository = conversationRepository;
        this.messageRepository = messageRepository;
        this.eventPublisher = eventPublisher;
    }

    public Conversation createOrGetConversation(String userAId, String userBId) {
        UserId a = UserId.of(userAId);
        UserId b = UserId.of(userBId);
        UserId first = a.value().compareTo(b.value()) <= 0 ? a : b;
        UserId second = a.value().compareTo(b.value()) <= 0 ? b : a;

        return conversationRepository
            .findByParticipants(first, second)
            .orElseGet(() -> conversationRepository.save(Conversation.create(first, second)));
    }

    @Override
    public ChatMessage send(SendMessageCommand command) {
        requireUserId(command.fromUserId(), "fromUserId");
        requireUserId(command.toUserId(), "toUserId");

        ChatMessage message = messageRepository.save(
            ChatMessage.create(ConversationId.of(command.conversationId()), UserId.of(command.fromUserId()), command.content())
        );

        eventPublisher.publish(
            new MessageSentEvent(
                message.id(),
                message.conversationId().toString(),
                message.senderId(),
                UserId.of(command.toUserId()),
                message.content(),
                Instant.now()
            )
        );
        return message;
    }

    @Override
    public List<ChatMessage> load(LoadHistoryQuery query) {
        return messageRepository.findByConversation(ConversationId.of(query.conversationId()), query.page(), query.size());
    }

    public ChatMessage markRead(String messageId) {
        ChatMessage message = messageRepository
            .findById(MessageId.of(messageId))
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Mensagem nao encontrada"));
        return messageRepository.save(message.markRead());
    }

    private static void requireUserId(String value, String fieldName) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(fieldName + " nao pode ser vazio");
        }
    }
}