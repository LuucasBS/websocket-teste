package com.seuprojeto.chat.infrastructure.websocket;

import com.seuprojeto.chat.application.chat.ChatApplicationService;
import com.seuprojeto.chat.application.chat.SendMessageCommand;
import com.seuprojeto.chat.interfaces.ws.ChatRequestEvent;
import com.seuprojeto.chat.interfaces.ws.MessageReadEvent;
import com.seuprojeto.chat.interfaces.ws.TypingEvent;
import com.seuprojeto.chat.interfaces.ws.WsMessagePayload;
import java.security.Principal;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

@Controller
public class ChatWebSocketHandler {

    private final ChatApplicationService chatApplicationService;
    private final SimpMessagingTemplate messagingTemplate;

    public ChatWebSocketHandler(ChatApplicationService chatApplicationService, SimpMessagingTemplate messagingTemplate) {
        this.chatApplicationService = chatApplicationService;
        this.messagingTemplate = messagingTemplate;
    }

    @MessageMapping("/chat.send")
    public void send(WsMessagePayload payload, Principal principal) {
        if (principal == null || principal.getName() == null || principal.getName().isBlank()) {
            throw new IllegalStateException("Usuario nao autenticado no WebSocket");
        }

        String fromUserId = principal.getName();
        chatApplicationService.send(
            new SendMessageCommand(payload.conversationId(), fromUserId, payload.toUserId(), payload.content())
        );
    }

    @MessageMapping("/chat.request")
    public void request(ChatRequestEvent event) {
        messagingTemplate.convertAndSendToUser(event.toUserId(), "/queue/notifications", event);
    }

    @MessageMapping("/chat.typing")
    public void typing(TypingEvent event) {
        messagingTemplate.convertAndSendToUser(event.fromUserId(), "/queue/notifications", event);
    }

    @MessageMapping("/chat.read")
    public void read(MessageReadEvent event) {
        chatApplicationService.markRead(event.messageId());
        messagingTemplate.convertAndSendToUser(event.readerUserId(), "/queue/notifications", event);
    }
}