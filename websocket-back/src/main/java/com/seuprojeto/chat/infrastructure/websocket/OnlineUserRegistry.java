package com.seuprojeto.chat.infrastructure.websocket;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class OnlineUserRegistry {

    private final Set<String> onlineUsers = ConcurrentHashMap.newKeySet();

    public void markOnline(String userId) {
        onlineUsers.add(userId);
    }

    public void markOffline(String userId) {
        onlineUsers.remove(userId);
    }

    public Set<String> listOnlineUserIds() {
        return Set.copyOf(onlineUsers);
    }
}