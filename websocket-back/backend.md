# 🟥 PROMPT — Backend Java 21: Chat em Tempo Real

---

## 🎯 Objetivo

Crie um backend **Java 21** com **Spring Boot 3.3+** para suportar um sistema de chat em tempo real. A arquitetura deve seguir **DDD**, **MVC**, **Clean Architecture** e as melhores práticas do ecossistema Spring.

---

## 🏗️ Stack & Versões

| Tecnologia | Versão | Uso |
|---|---|---|
| Java | 21 (LTS) | Virtual Threads, Records, Pattern Matching |
| Spring Boot | 3.3+ | Framework principal |
| Spring Security | 6.x | JWT + filtros |
| Spring WebSocket | — | STOMP sobre WebSocket |
| Spring Data JPA | — | Persistência |
| H2 | — | Banco local padrão |
| PostgreSQL | 16 | Perfil opcional |
| Flyway | — | Migrations |
| MapStruct | 1.5+ | Mappers DTO ↔ Domain |
| SpringDoc OpenAPI | 2.x | Documentação automática |
| TestContainers | — | Testes de integração |
| Redis | — | Substituído por armazenamento em memória |

---

## 📁 Estrutura de Pacotes (DDD + Hexagonal)

```
src/main/java/com/seuprojeto/chat/
├── domain/                          # Núcleo — zero dependência de framework
│   ├── user/
│   │   ├── User.java                # Aggregate Root (record ou classe imutável)
│   │   ├── UserId.java              # Value Object
│   │   ├── UserStatus.java          # Enum: ONLINE, OFFLINE
│   │   └── UserRepository.java      # Port (interface)
│   ├── conversation/
│   │   ├── Conversation.java        # Aggregate Root
│   │   ├── ConversationId.java      # Value Object
│   │   └── ConversationRepository.java
│   ├── message/
│   │   ├── ChatMessage.java         # Entity
│   │   ├── MessageId.java           # Value Object
│   │   ├── MessageStatus.java       # Enum: SENT, DELIVERED, READ
│   │   └── MessageRepository.java
│   └── event/
│       ├── DomainEvent.java         # Interface base (sealed)
│       ├── MessageSentEvent.java
│       ├── UserConnectedEvent.java
│       └── EventPublisher.java      # Port
│
├── application/                     # Use Cases / Serviços de aplicação
│   ├── auth/
│   │   ├── AuthUseCase.java
│   │   ├── LoginCommand.java        # Command (record)
│   │   └── TokenResponse.java      # DTO de saída
│   ├── chat/
│   │   ├── SendMessageUseCase.java
│   │   ├── SendMessageCommand.java
│   │   ├── LoadHistoryUseCase.java
│   │   └── LoadHistoryQuery.java
│   └── user/
│       ├── ListOnlineUsersUseCase.java
│       └── UpdateUserStatusUseCase.java
│
├── infrastructure/                  # Adaptadores / implementações concretas
│   ├── persistence/
│   │   ├── user/
│   │   │   ├── UserJpaEntity.java       # @Entity JPA
│   │   │   ├── UserJpaRepository.java   # Spring Data JPA
│   │   │   ├── UserMapper.java          # MapStruct
│   │   │   └── UserRepositoryAdapter.java # Implementa domain.UserRepository
│   │   ├── message/
│   │   └── conversation/
│   ├── websocket/
│   │   ├── WebSocketConfig.java
│   │   ├── ChatWebSocketHandler.java    # Lógica STOMP
│   │   ├── WebSocketEventPublisher.java # Implementa domain.EventPublisher
│   │   └── OnlineUserRegistry.java     # Registros online em memória
│   ├── security/
│   │   ├── JwtTokenProvider.java
│   │   ├── JwtAuthenticationFilter.java
│   │   └── SecurityConfig.java
│   └── redis/
│       └── RedisConfig.java           # Removido no runtime local
│
└── interfaces/                      # Entrada: Controllers REST + WS
    ├── rest/
    │   ├── auth/
    │   │   ├── AuthController.java
    │   │   ├── LoginRequest.java    # DTO de entrada (record)
    │   │   └── LoginResponse.java
    │   ├── user/
    │   │   ├── UserController.java
    │   │   └── UserResponse.java
    │   └── chat/
    │       ├── ChatController.java
    │       ├── MessageRequest.java
    │       └── MessageResponse.java
    └── ws/
        ├── WsMessagePayload.java
        └── WsNotificationPayload.java
```

---

## 🔐 Autenticação JWT

```java
// LoginRequest.java — record com validação Jakarta
public record LoginRequest(
    @NotBlank String username,
    @NotBlank @Size(min = 6) String password
) {}

// JwtTokenProvider — gera e valida tokens
// - Algoritmo: HS256 com chave de 512 bits via @Value
// - Claims: sub (userId), username, roles, iat, exp (8h default)
// - Métodos: generateToken(User), validateToken(String), extractUserId(String)

// JwtAuthenticationFilter extends OncePerRequestFilter
// - Extrai Bearer token do header Authorization
// - Valida com JwtTokenProvider
// - Popula SecurityContextHolder com UsernamePasswordAuthenticationToken
```

**Endpoints de autenticação:**

```
POST /api/v1/auth/login     → { token, expiresAt, user: UserResponse }
POST /api/v1/auth/refresh   → { token, expiresAt }
POST /api/v1/auth/logout    → 204 (invalida sessão em memória)
```

---

## 🌐 WebSocket com STOMP

```java
// WebSocketConfig.java
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    // Registry: /ws endpoint, SockJS fallback
    // Message broker: /topic (broadcast), /queue (individual)
    // App prefix: /app
    // User destination prefix: /user
}

// Tópicos STOMP:
// /topic/users.online                    → lista de usuários online (broadcast)
// /user/{userId}/queue/messages          → mensagens individuais
// /user/{userId}/queue/notifications     → notificações (pedido de chat, etc.)
// /app/chat.send                         → enviar mensagem
// /app/chat.request                      → solicitar conversa
// /app/chat.typing                       → emitir "digitando..."
// /app/chat.read                         → marcar como lido
```

**Payload tipado dos eventos WS — sealed interface (Java 21):**

```java
public sealed interface WsEvent permits
    MessageEvent,
    TypingEvent,
    ChatRequestEvent,
    UserStatusEvent,
    MessageReadEvent {}

public record MessageEvent(
    String type,            // "MESSAGE"
    String conversationId,
    String fromUserId,
    String content,
    Instant sentAt,
    String messageId
) implements WsEvent {}
```

---

## 📦 DTOs e Mappers (MapStruct)

> **Regra:** NUNCA expor entidades JPA nem Domain objects diretamente. Todos os retornos de controller usam Response records.

```java
// UserResponse.java
public record UserResponse(
    String id,
    String username,
    String status,
    Instant lastSeen
) {}

// MessageResponse.java
public record MessageResponse(
    String id,
    String conversationId,
    String fromUserId,
    String content,
    String status,   // SENT | DELIVERED | READ
    Instant sentAt
) {}

// Mapper com MapStruct
@Mapper(componentModel = "spring")
public interface UserMapper {
    UserResponse toResponse(User user);
    User toDomain(UserJpaEntity entity);
    UserJpaEntity toEntity(User user);
}
```

---

## 🏛️ Domain — Princípios DDD

```java
// User.java — Aggregate Root imutável com Java 21 record
public record User(
    UserId id,
    String username,
    String passwordHash,
    UserStatus status,
    Instant createdAt,
    Instant lastSeen
) {
    // Factory method — nunca new direto no domain
    public static User create(String username, String passwordHash) {
        return new User(
            UserId.generate(),
            username,
            passwordHash,
            UserStatus.OFFLINE,
            Instant.now(),
            Instant.now()
        );
    }

    public User markOnline() {
        return new User(id, username, passwordHash, UserStatus.ONLINE, createdAt, Instant.now());
    }
}

// Value Object tipado
public record UserId(UUID value) {
    public static UserId generate() { return new UserId(UUID.randomUUID()); }
    public static UserId of(String value) { return new UserId(UUID.fromString(value)); }
}
```

---

## 🔔 Sistema de Notificações

```java
// NotificationService — orquestra via eventos de domínio
// Ao receber MessageSentEvent:
//   1. Persiste notificação no banco
//   2. Publica via STOMP em /user/{recipientId}/queue/notifications
//   3. Atualiza badge count em memória: chat:unread:{userId}:{conversationId}

// Payload de notificação:
public record WsNotificationPayload(
    String type,          // "NEW_MESSAGE" | "CHAT_REQUEST"
    String fromUsername,
    String conversationId,
    String preview,       // primeiros 60 chars da mensagem
    int unreadCount,
    Instant timestamp
) {}
```

---

## 🗄️ Persistência — Flyway Migrations

```sql
-- V1__init.sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    VARCHAR(50) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'OFFLINE',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ
);

CREATE TABLE conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a_id   UUID NOT NULL REFERENCES users(id),
    user_b_id   UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    sender_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'SENT',
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ,
    read_at         TIMESTAMPTZ
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, sent_at DESC);
```

---

## ⚙️ Configurações & Boas Práticas

```yaml
# application.yml
spring:
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}
  datasource:
    url: jdbc:h2:mem:chatdb;MODE=PostgreSQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE
    username: sa
    password:
    driver-class-name: org.h2.Driver
  jpa:
    hibernate.ddl-auto: create-drop
    open-in-view: false
  threads:
    virtual:
      enabled: true                # Virtual Threads — Java 21

app:
  jwt:
    secret: ${JWT_SECRET}          # mínimo 512 bits, nunca no código
    expiration: 28800              # 8h em segundos
  websocket:
    heartbeat: 25000
    disconnect-delay: 5000
```

---

## 🧪 Testes

```
# Estrutura por camada:

Unit (sem Spring, sem banco):
  UserTest.java                → testa User.create(), markOnline(), regras de negócio
  SendMessageUseCaseTest.java  → mocks dos ports com Mockito

Integration (TestContainers — PostgreSQL reais):
  @SpringBootTest + @Testcontainers
  AuthControllerIT.java        → fluxo completo de login
  ChatWebSocketIT.java         → conecta via STOMP, envia mensagem, verifica recebimento

Architecture (ArchUnit):
  LayerDependencyTest.java     → domain nunca importa infrastructure
  NoCyclesTest.java            → sem dependências circulares
```

---

## ▶ Execução Local

```bash
./mvnw spring-boot:run
```

O perfil padrão é `local`, com banco H2 em memória e sem Redis. Se quiser usar PostgreSQL em vez de H2, rode com `SPRING_PROFILES_ACTIVE=dev` e forneça um banco PostgreSQL local.

---

## 🌐 Endpoints REST

```
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
POST   /api/v1/auth/refresh

GET    /api/v1/users/online                          → usuários conectados agora
GET    /api/v1/users/{id}

POST   /api/v1/conversations                         → cria ou retorna conversa existente
GET    /api/v1/conversations/{id}/messages?page=0&size=50
PATCH  /api/v1/messages/{id}/read
```

---

## 🏛️ Arquitetura — Visão Geral

```
Angular 21
    │  HTTP/WS
    ▼
Security Filter (JWT validation)
    │
    ▼
Controllers REST + WS
  AuthController · ChatController · UserController
    │  DTOs
    ▼
Application Layer — Use Cases
  AuthUseCase · ChatUseCase · UserQueryUseCase
    │
    ▼
Domain Layer (zero framework)
  User · ChatMessage · Conversation
  UserRepository (port) · EventPublisher (port)
    │
    ▼
Infrastructure Layer
  JPA Repositories · WebSocketHandler · JWT Provider · Mappers
    │                     │
    ▼                     ▼
H2 / PostgreSQL      In-memory Registry
(local / opcional)   (sessões online e blacklist JWT)

Cross-Cutting (transversal a todas as camadas):
  GlobalExceptionHandler · RequestLoggingFilter
  AuditListener · ApplicationEventBus
  SpringDoc/OpenAPI · Actuator + Micrometer
  TestContainers · Profiles local/dev/test
```

---

## ✅ Critérios de Aceite

- [ ] Zero lógica de negócio nos Controllers — apenas delegar ao UseCase
- [ ] Domain layer sem nenhuma anotação Spring ou JPA
- [ ] Todos os retornos são Records tipados (sem `Map<String, Object>`)
- [ ] JWT validado via filtro **antes** de chegar nos endpoints
- [ ] WebSocket autentica via token no header do handshake
- [ ] Flyway versiona **todo** o schema — `ddl-auto: validate`
- [ ] Pelo menos 1 teste de integração com TestContainers cobrindo login
- [ ] ArchUnit garantindo que `domain` nunca depende de `infrastructure`
- [ ] Virtual Threads habilitados (`spring.threads.virtual.enabled: true`)
- [ ] Nenhuma entidade JPA exposta diretamente pela API