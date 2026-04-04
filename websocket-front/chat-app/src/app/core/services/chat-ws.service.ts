import { HttpClient } from '@angular/common/http';
import { Injectable, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { Client, StompSubscription } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { Observable, Subject, Subscription, catchError, map, of, switchMap, tap, timer } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ChatMessage } from '../../shared/models/message.model';
import { User } from '../../shared/models/user.model';
import { WsEvent } from '../../shared/models/ws-event.model';
import { AuthService } from './auth.service';

type OutboundWsEvent = WsEvent | { type: 'PING' };

interface ConversationResponse {
  id: string;
  userAId: string;
  userBId: string;
  createdAt: string;
}

interface MessageResponse {
  id: string;
  conversationId: string;
  fromUserId: string;
  content: string;
  status: 'SENT' | 'DELIVERED' | 'READ';
  sentAt: string;
}

interface UserResponse {
  id: string;
  username: string;
  status: string;
  lastSeen?: string;
}

interface BackendMessageEvent {
  type: string;
  conversationId: string;
  fromUserId: string;
  content: string;
  sentAt: string;
  messageId: string;
}

interface BackendTypingEvent {
  type: string;
  conversationId: string;
  fromUserId: string;
  typing: boolean;
}

interface BackendChatRequestEvent {
  type: string;
  fromUserId: string;
  toUserId: string;
}

@Injectable({ providedIn: 'root' })
export class ChatWebSocketService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);

  private readonly eventBus = new Subject<WsEvent>();
  private stompClient: Client | null = null;
  private heartbeatSubscription?: Subscription;
  private reconnectSubscription?: Subscription;
  private onlineUsersSubscription?: Subscription;
  private userMessagesSubscription?: StompSubscription;
  private userNotificationsSubscription?: StompSubscription;

  private reconnectAttempts = 0;
  private readonly maxBackoffMs = 30000;
  private readonly pendingQueue: OutboundWsEvent[] = [];
  private readonly conversationSubscriptions = new Set<string>();
  private readonly conversationByUserId = signal<Record<string, string>>({});
  private readonly userByConversationId = signal<Record<string, string>>({});

  private readonly _connected = signal(false);
  private readonly _usersOnline = signal<User[]>([]);
  private readonly _typingByUserId = signal<Record<string, boolean>>({});
  private readonly _conversationStreams = signal<Map<string, WritableSignal<ChatMessage[]>>>(new Map());

  readonly connected = this._connected.asReadonly();
  readonly usersOnline = this._usersOnline.asReadonly();
  readonly typingByUserId = this._typingByUserId.asReadonly();
  readonly events$ = this.eventBus.asObservable();
  readonly isDisconnected = computed(() => !this._connected());

  constructor() {
    effect(() => {
      const user = this.authService.currentUser();
      if (!user) {
        this.disconnect();
      }
    });
  }

  connect(): void {
    if (this.stompClient?.active) {
      return;
    }

    const token = this.authService.getToken();
    this.stompClient = new Client({
      webSocketFactory: () => new SockJS(environment.wsUrl),
      connectHeaders: token ? { Authorization: `Bearer ${token}` } : {},
      reconnectDelay: 0,
      heartbeatIncoming: 20000,
      heartbeatOutgoing: 20000,
      onConnect: () => {
        this._connected.set(true);
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.startOnlineUsersPolling();
        this.subscribeUserQueues();
        this.flushQueue();
        this.stompClient?.publish({ destination: '/app/user.online', body: '{}' });
      },
      onWebSocketClose: () => this.handleDisconnected(),
      onStompError: () => this.handleDisconnected()
    });
    this.stompClient.activate();
  }

  disconnect(): void {
    this.heartbeatSubscription?.unsubscribe();
    this.reconnectSubscription?.unsubscribe();
    this.onlineUsersSubscription?.unsubscribe();
    this.userMessagesSubscription?.unsubscribe();
    this.userNotificationsSubscription?.unsubscribe();
    this.userMessagesSubscription = undefined;
    this.userNotificationsSubscription = undefined;
    this.conversationSubscriptions.clear();
    this.stompClient?.deactivate();
    this.stompClient = null;
    this._connected.set(false);
    this._usersOnline.set([]);
    this._typingByUserId.set({});
  }

  conversationSignal(withUserId: string): WritableSignal<ChatMessage[]> {
    const known = this._conversationStreams().get(withUserId);
    if (known) {
      return known;
    }

    const nextSignal = signal<ChatMessage[]>([]);
    this._conversationStreams.update((value) => {
      const updated = new Map(value);
      updated.set(withUserId, nextSignal);
      return updated;
    });

    return nextSignal;
  }

  mergeConversationHistory(withUserId: string, history: ChatMessage[]): void {
    const stream = this.conversationSignal(withUserId);
    const orderedHistory = [...history].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    stream.set(orderedHistory.slice(-50));
  }

  resolveDisplayName(userId: string): string {
    if (!userId) {
      return 'Contato';
    }

    const currentUser = this.authService.currentUser();
    if (currentUser?.id === userId) {
      return currentUser.displayName ?? currentUser.username;
    }

    const knownUser = this._usersOnline().find((user) => user.id === userId);
    if (knownUser) {
      return knownUser.displayName || knownUser.username || 'Contato';
    }

    return 'Contato';
  }

  loadHistory(withUserId: string, limit = 50): Observable<ChatMessage[]> {
    return this.ensureConversation(withUserId).pipe(
      switchMap((conversationId) =>
        this.http.get<MessageResponse[]>(`${environment.apiUrl}/conversations/${conversationId}/messages?page=0&size=${limit}`).pipe(
          map((history) => history.map((message) => this.mapMessageResponse(message, withUserId))),
          tap((history) => this.mergeConversationHistory(withUserId, history))
        )
      ),
      catchError(() => of([]))
    );
  }

  sendMessage(payload: ChatMessage): void {
    this.emitOrQueue({ type: 'MESSAGE', payload });
  }

  sendChatRequest(from: User, toUserId: string): void {
    this.emitOrQueue({
      type: 'CHAT_REQUEST',
      payload: { from, toUserId }
    });
  }

  sendTyping(toUserId: string, userId: string, isTyping: boolean): void {
    this.emitOrQueue({
      type: 'TYPING',
      payload: { userId, isTyping, toUserId }
    });
  }

  private emitOrQueue(event: OutboundWsEvent): void {
    if (!this.stompClient || !this.stompClient.connected || !this._connected()) {
      this.pendingQueue.push(event);
      this.connect();
      return;
    }

    this.publishEvent(event);
  }

  private flushQueue(): void {
    if (!this.stompClient || !this.stompClient.connected) {
      return;
    }

    while (this.pendingQueue.length > 0) {
      const event = this.pendingQueue.shift();
      if (event) {
        this.publishEvent(event);
      }
    }
  }

  private publishEvent(event: OutboundWsEvent): void {
    if (event.type === 'PING' || !this.stompClient?.connected) {
      return;
    }

    if (event.type === 'MESSAGE') {
      if (!event.payload.toUserId) {
        return;
      }

      void this.ensureConversation(event.payload.toUserId).subscribe((conversationId) => {
        this.subscribeConversation(conversationId, event.payload.toUserId);
        this.stompClient?.publish({
          destination: '/app/chat.send',
          body: JSON.stringify({
            type: 'MESSAGE',
            conversationId,
            fromUserId: event.payload.fromUserId,
            toUserId: event.payload.toUserId,
            content: event.payload.content,
            sentAt: event.payload.timestamp,
            messageId: event.payload.id
          })
        });
      });
      return;
    }

    if (event.type === 'CHAT_REQUEST') {
      if (!event.payload.toUserId) {
        return;
      }
      void this.ensureConversation(event.payload.toUserId).subscribe(() => {
        this.stompClient?.publish({
          destination: '/app/chat.request',
          body: JSON.stringify({
            type: 'CHAT_REQUEST',
            fromUserId: event.payload.from.id,
            toUserId: event.payload.toUserId
          })
        });
      });
      return;
    }

    if (event.type === 'TYPING') {
      if (!event.payload.toUserId) {
        return;
      }
      void this.ensureConversation(event.payload.toUserId).subscribe((conversationId) => {
        this.stompClient?.publish({
          destination: '/app/chat.typing',
          body: JSON.stringify({
            type: 'TYPING',
            conversationId,
            fromUserId: event.payload.userId,
            typing: event.payload.isTyping
          })
        });
      });
    }
  }

  private subscribeConversation(conversationId: string, withUserId: string): void {
    if (!this.stompClient?.connected || this.conversationSubscriptions.has(conversationId)) {
      return;
    }

    this.conversationByUserId.update((value) => ({ ...value, [withUserId]: conversationId }));
    this.userByConversationId.update((value) => ({ ...value, [conversationId]: withUserId }));
    this.conversationSubscriptions.add(conversationId);
  }

  private ensureConversation(withUserId: string): Observable<string> {
    const known = this.conversationByUserId()[withUserId];
    if (known) {
      this.subscribeConversation(known, withUserId);
      return of(known);
    }

    const me = this.authService.currentUser();
    if (!me) {
      return of('');
    }

    return this.http
      .post<ConversationResponse>(`${environment.apiUrl}/conversations`, {
        userAId: me.id,
        userBId: withUserId
      })
      .pipe(
        map((conversation) => conversation.id),
        tap((conversationId) => this.subscribeConversation(conversationId, withUserId))
      );
  }

  private startOnlineUsersPolling(): void {
    this.onlineUsersSubscription?.unsubscribe();
    this.onlineUsersSubscription = timer(0, 10000)
      .pipe(
        switchMap(() => this.http.get<UserResponse[]>(`${environment.apiUrl}/users/online`).pipe(catchError(() => of([]))))
      )
      .subscribe((users) => {
        this._usersOnline.set(
          users.map((user) => ({
            id: user.id,
            username: user.username,
            displayName: user.username,
            online: user.status === 'ONLINE'
          }))
        );
      });
  }

  private subscribeUserQueues(): void {
    if (!this.stompClient?.connected) {
      return;
    }

    if (!this.userMessagesSubscription) {
      this.userMessagesSubscription = this.stompClient.subscribe('/user/queue/messages', (frame) => {
        const raw = JSON.parse(frame.body) as BackendMessageEvent;
        const me = this.authService.currentUser();
        const knownWithUserId = this.userByConversationId()[raw.conversationId];
        const withUserId = raw.fromUserId === me?.id ? knownWithUserId : raw.fromUserId;

        if (!withUserId) {
          return;
        }

        this.conversationByUserId.update((value) => ({ ...value, [withUserId]: raw.conversationId }));
        this.userByConversationId.update((value) => ({ ...value, [raw.conversationId]: withUserId }));

        const message = this.mapIncomingMessage(raw, withUserId);
        this.pushMessageIntoStream(message);
        this.eventBus.next({ type: 'MESSAGE', payload: message });
      });
    }

    if (!this.userNotificationsSubscription) {
      this.userNotificationsSubscription = this.stompClient.subscribe('/user/queue/notifications', (frame) => {
        const event = JSON.parse(frame.body) as unknown;

        if (this.isChatRequestEvent(event)) {
          this.handleChatRequest(event);
          return;
        }

        if (this.isTypingEvent(event)) {
          this.handleTypingEvent(event);
        }
      });
    }
  }

  private isChatRequestEvent(event: unknown): event is BackendChatRequestEvent {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const payload = event as Record<string, unknown>;
    return (
      payload['type'] === 'CHAT_REQUEST' &&
      typeof payload['fromUserId'] === 'string' &&
      typeof payload['toUserId'] === 'string'
    );
  }

  private isTypingEvent(event: unknown): event is BackendTypingEvent {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const payload = event as Record<string, unknown>;
    return (
      payload['type'] === 'TYPING' &&
      typeof payload['conversationId'] === 'string' &&
      typeof payload['fromUserId'] === 'string' &&
      typeof payload['typing'] === 'boolean'
    );
  }

  private handleChatRequest(event: BackendChatRequestEvent): void {
    const me = this.authService.currentUser();
    if (!me || event.toUserId !== me.id || event.fromUserId === me.id) {
      return;
    }

    const fromUser = this._usersOnline().find((user) => user.id === event.fromUserId) ?? {
      id: event.fromUserId,
      username: this.resolveDisplayName(event.fromUserId),
      displayName: this.resolveDisplayName(event.fromUserId),
      online: true
    };

    this.eventBus.next({
      type: 'CHAT_REQUEST',
      payload: { from: fromUser, toUserId: event.toUserId }
    });
  }

  private handleTypingEvent(event: BackendTypingEvent): void {
    const me = this.authService.currentUser();
    if (!me || event.fromUserId === me.id) {
      return;
    }

    const knownWithUserId = this.userByConversationId()[event.conversationId];
    const withUserId = knownWithUserId ?? event.fromUserId;

    this.conversationByUserId.update((value) => ({ ...value, [withUserId]: event.conversationId }));
    this.userByConversationId.update((value) => ({ ...value, [event.conversationId]: withUserId }));
    this._typingByUserId.update((value) => ({
      ...value,
      [event.fromUserId]: event.typing
    }));
    this.eventBus.next({ type: 'TYPING', payload: { userId: event.fromUserId, isTyping: event.typing } });
  }

  private pushMessageIntoStream(message: ChatMessage): void {
    const selfId = this.authService.currentUser()?.id;
    if (!selfId) {
      return;
    }

    const withUserId = message.fromUserId === selfId ? message.toUserId : message.fromUserId;
    const stream = this.conversationSignal(withUserId);
    stream.update((value) => {
      const withoutSameId = value.filter((item) => item.id !== message.id);
      return [...withoutSameId, message].slice(-200);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatSubscription?.unsubscribe();
    this.heartbeatSubscription = timer(30000, 30000).subscribe(() => {
      if (!this.stompClient?.connected) {
        this.handleDisconnected();
      }
    });
  }

  private handleDisconnected(): void {
    this._connected.set(false);
    this.heartbeatSubscription?.unsubscribe();
    this.onlineUsersSubscription?.unsubscribe();
    this.userMessagesSubscription?.unsubscribe();
    this.userNotificationsSubscription?.unsubscribe();
    this.userMessagesSubscription = undefined;
    this.userNotificationsSubscription = undefined;
    this.conversationSubscriptions.clear();

    if (!this.authService.isAuthenticated()) {
      return;
    }

    this.reconnectAttempts += 1;
    const backoff = Math.min(2 ** (this.reconnectAttempts - 1) * 1000, this.maxBackoffMs);

    this.reconnectSubscription?.unsubscribe();
    this.reconnectSubscription = timer(backoff).subscribe(() => {
      this.connect();
    });
  }

  private mapMessageResponse(message: MessageResponse, withUserId: string): ChatMessage {
    const me = this.authService.currentUser();
    return {
      id: message.id,
      fromUserId: message.fromUserId,
      toUserId: message.fromUserId === me?.id ? withUserId : me?.id ?? withUserId,
      content: message.content,
      timestamp: message.sentAt,
      status: message.status
    };
  }

  private mapIncomingMessage(message: BackendMessageEvent, withUserId: string): ChatMessage {
    const me = this.authService.currentUser();
    return {
      id: message.messageId,
      fromUserId: message.fromUserId,
      toUserId: message.fromUserId === me?.id ? withUserId : me?.id ?? withUserId,
      content: message.content,
      timestamp: message.sentAt,
      status: 'SENT'
    };
  }
}
