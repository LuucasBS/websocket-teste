package com.seuprojeto.chat.infrastructure.websocket;

import java.util.Arrays;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Value("${app.cors.allowed-origins:http://localhost:*,http://127.0.0.1:*,http://[::1]:*}")
    private String allowedOrigins;

    private final JwtWebSocketChannelInterceptor jwtWebSocketChannelInterceptor;

    public WebSocketConfig(JwtWebSocketChannelInterceptor jwtWebSocketChannelInterceptor) {
        this.jwtWebSocketChannelInterceptor = jwtWebSocketChannelInterceptor;
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry
            .addEndpoint("/ws")
            .setAllowedOriginPatterns(parseAllowedOrigins())
            .withSockJS();
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic", "/queue");
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(jwtWebSocketChannelInterceptor);
    }

    private String[] parseAllowedOrigins() {
        return Arrays
            .stream(allowedOrigins.split(","))
            .map(String::trim)
            .filter(origin -> !origin.isBlank())
            .toArray(String[]::new);
    }
}