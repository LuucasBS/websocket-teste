import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { animate, style, transition, trigger } from '@angular/animations';
import { Subject, Subscription, catchError, debounceTime, finalize, of } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ChatWebSocketService } from '../../core/services/chat-ws.service';
import { NotificationService } from '../../core/services/notification.service';
import { ChatMessage } from '../../shared/models/message.model';
import { ChatHeaderComponent } from './chat-header/chat-header.component';
import { MessageBubbleComponent } from './message-bubble/message-bubble.component';

@Component({
  selector: 'app-chat',
  imports: [FormsModule, ChatHeaderComponent, MessageBubbleComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('fadeIn', [
      transition(':enter', [style({ opacity: 0 }), animate('220ms ease-out', style({ opacity: 1 }))])
    ]),
    trigger('slideUp', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(8px)' }),
        animate('220ms ease-out', style({ opacity: 1, transform: 'translateY(0)' }))
      ])
    ])
  ]
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('endAnchor')
  private endAnchor?: ElementRef<HTMLDivElement>;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly wsService = inject(ChatWebSocketService);
  private readonly notifications = inject(NotificationService);

  private readonly subscriptions = new Subscription();
  private readonly typingStop$ = new Subject<void>();

  protected readonly currentUser = this.authService.currentUser;
  protected readonly isConnected = this.wsService.connected;

  protected readonly activeUserId = signal('');
  protected readonly activeUserName = signal('Contato');
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly loadingHistory = signal(true);
  protected readonly draft = signal('');

  protected readonly charCount = computed(() => this.draft().length);
  protected readonly canSend = computed(() => this.charCount() > 0 && this.charCount() <= 500);
  protected readonly typingIndicator = computed(() => {
    const userId = this.activeUserId();
    return userId ? this.wsService.typingByUserId()[userId] ?? false : false;
  });

  constructor() {
    this.wsService.connect();

    effect(() => {
      const chatUserId = this.activeUserId();
      if (!chatUserId) {
        return;
      }

      const stream = this.wsService.conversationSignal(chatUserId);
      this.messages.set(stream());
      this.notifications.clearUnread(chatUserId);
      this.scrollToBottom();
    });

    effect(() => {
      const chatUserId = this.activeUserId();
      if (!chatUserId) {
        return;
      }

      this.activeUserName.set(this.wsService.resolveDisplayName(chatUserId));
    });
  }

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.paramMap.subscribe((params) => {
        const userId = params.get('userId');
        if (!userId) {
          return;
        }

        this.activeUserId.set(userId);
        this.activeUserName.set(this.wsService.resolveDisplayName(userId));
        this.notifications.clearPendingRequest(userId);
        this.loadHistory(userId);
      })
    );

    this.subscriptions.add(
      this.typingStop$.pipe(debounceTime(500)).subscribe(() => {
        const me = this.currentUser();
        if (!me || !this.activeUserId()) {
          return;
        }

        this.wsService.sendTyping(this.activeUserId(), me.id, false);
      })
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  protected trackByMessage(index: number, message: ChatMessage): string {
    return message.id;
  }

  protected isOwnMessage(message: ChatMessage): boolean {
    return message.fromUserId === this.currentUser()?.id;
  }

  protected onDraftInput(value: string): void {
    if (value.length > 500) {
      this.draft.set(value.slice(0, 500));
      return;
    }

    this.draft.set(value);

    const me = this.currentUser();
    if (!me || !this.activeUserId()) {
      return;
    }

    this.wsService.sendTyping(this.activeUserId(), me.id, true);
    this.typingStop$.next();
  }

  protected sendMessage(): void {
    if (!this.canSend()) {
      return;
    }

    const me = this.currentUser();
    const activeUserId = this.activeUserId();
    if (!me || !activeUserId) {
      return;
    }

    const content = this.draft().trim();
    if (!content) {
      return;
    }

    const message: ChatMessage = {
      id: this.randomId(),
      fromUserId: me.id,
      toUserId: activeUserId,
      content,
      timestamp: new Date().toISOString(),
      status: 'SENT'
    };

    this.wsService.sendMessage(message);
    this.wsService.sendTyping(activeUserId, me.id, false);
    this.draft.set('');
    this.scrollToBottom();
  }

  protected onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  protected backToLobby(): void {
    void this.router.navigate(['/lobby']);
  }

  private loadHistory(userId: string): void {
    this.loadingHistory.set(true);

    this.subscriptions.add(
      this.wsService
        .loadHistory(userId, 50)
        .pipe(
          catchError(() => of([])),
          finalize(() => this.loadingHistory.set(false))
        )
        .subscribe((history) => {
          this.scrollToBottom();
        })
    );
  }

  private scrollToBottom(): void {
    queueMicrotask(() => {
      this.endAnchor?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  private randomId(): string {
    return `${Date.now()}-${Math.round(Math.random() * 100000)}`;
  }
}
