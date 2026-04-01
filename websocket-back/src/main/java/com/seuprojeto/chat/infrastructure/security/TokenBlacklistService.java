package com.seuprojeto.chat.infrastructure.security;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

@Service
public class TokenBlacklistService {

    private final Map<String, Instant> blacklistedTokens = new ConcurrentHashMap<>();

    public void blacklist(String token, long ttlSeconds) {
        if (token == null || token.isBlank()) {
            return;
        }
        if (ttlSeconds <= 0) {
            return;
        }
        blacklistedTokens.put(key(token), Instant.now().plusSeconds(ttlSeconds));
    }

    public boolean isBlacklisted(String token) {
        if (token == null || token.isBlank()) {
            return false;
        }
        String key = key(token);
        Instant expiresAt = blacklistedTokens.get(key);
        if (expiresAt == null) {
            return false;
        }
        if (Instant.now().isAfter(expiresAt)) {
            blacklistedTokens.remove(key);
            return false;
        }
        return true;
    }

    private String key(String token) {
        return "auth:blacklist:" + token;
    }
}