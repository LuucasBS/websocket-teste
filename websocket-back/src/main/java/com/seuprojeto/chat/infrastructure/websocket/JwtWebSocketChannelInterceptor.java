package com.seuprojeto.chat.infrastructure.websocket;

import com.seuprojeto.chat.infrastructure.security.JwtTokenProvider;
import com.seuprojeto.chat.infrastructure.security.TokenBlacklistService;
import java.util.List;
import org.springframework.http.HttpHeaders;
import org.springframework.lang.NonNull;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

@Component
public class JwtWebSocketChannelInterceptor implements ChannelInterceptor {

    private final JwtTokenProvider jwtTokenProvider;
    private final TokenBlacklistService tokenBlacklistService;

    public JwtWebSocketChannelInterceptor(JwtTokenProvider jwtTokenProvider, TokenBlacklistService tokenBlacklistService) {
        this.jwtTokenProvider = jwtTokenProvider;
        this.tokenBlacklistService = tokenBlacklistService;
    }

    @Override
    public Message<?> preSend(@NonNull Message<?> message, @NonNull MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() != StompCommand.CONNECT) {
            return message;
        }

        String token = JwtTokenProvider.stripBearerPrefix(accessor.getFirstNativeHeader(HttpHeaders.AUTHORIZATION));
        if (token.isBlank() || !jwtTokenProvider.validateToken(token) || tokenBlacklistService.isBlacklisted(token)) {
            return message;
        }

        Authentication authentication = new UsernamePasswordAuthenticationToken(
            jwtTokenProvider.extractUserId(token),
            null,
            List.of(new SimpleGrantedAuthority("ROLE_USER"))
        );
        accessor.setUser(authentication);
        return message;
    }
}