// src/app/chat/chat.page.ts
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs/operators';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatApiService, ReminderResponse } from '../services/chat-api.service';

type Role = 'assistant' | 'user';
type ChatOption = string | { label?: string; value?: string };
type OfferCard = {
  value: string;
  title: string;
  subtitle: string;
  features: string[];
  price: string;
};

const makeId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const INITIAL_PROMPT =
  'Bonjour ! En 30 secondes, nous voyons si on peut baisser vos cotisations ou améliorer vos garanties.\nQuelle est votre priorité ?';
const INITIAL_OPTIONS = [
  'Faire baisser les cotisations',
  'Améliorer/optimiser les garanties',
];
const REMINDER_DELAY_MS = 30_000;
const OFFER_NAMES = ['Zen Santé Évolutive', 'FMA Vitalia'];
const OFFER_CARDS: OfferCard[] = [
  {
    value: OFFER_NAMES[0],
    title: OFFER_NAMES[0],
    subtitle: 'Zen',
    features: [
      'Accès aux médecines douces pour un bien-être optimal',
      'Réseaux Kalixia pour des soins de qualité',
      'Téléconsultation illimitée',
      'Chambre particulière & transports',
    ],
    price: 'À partir de 29 €/mois',
  },
  {
    value: OFFER_NAMES[1],
    title: OFFER_NAMES[1],
    subtitle: 'FMA',
    features: [
      'Garantie frais réel hospitalisation',
      'Frais réel hospitalisation',
      'Tiers payant',
      'Service à domicile',
    ],
    price: 'À partir de 29 €/mois',
  },
];

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  ts: Date;
}

interface ChatResponse {
  response: string;
  conversation_id: string;
  extracted_fields?: Record<string, unknown>;
  completion_status?: Record<string, boolean>;
  all_fields_complete?: boolean;
  phase?: string;
  options?: ChatOption[];
  input_type?: string;
}

@Component({
  selector: 'app-chat-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatToolbarModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './chat.page.html',
  styleUrls: ['./chat.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPage implements AfterViewInit {
  private readonly chatApi = inject(ChatApiService);
  @ViewChild('chatScroll') private chatScroll?: ElementRef<HTMLDivElement>;
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private reminderForAssistantId: string | null = null;

  // ====== Signals (state) ======
  readonly conversationId = signal<string | null>(null);

  readonly messages = signal<ChatMessage[]>([
    {
      id: makeId(),
      role: 'assistant',
      text: INITIAL_PROMPT,
      ts: new Date(),
    },
  ]);

  readonly input = signal<string>('');
  readonly sending = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly quickReplies = signal<string[]>([...INITIAL_OPTIONS]);
  readonly inputType = signal<string>('text');
  readonly phase = signal<string | null>(null);
  readonly offerCards = computed(() => {
    const options = this.quickReplies();
    if (!this.isOfferOptions(options)) return [];
    return OFFER_CARDS;
  });
  readonly showOfferCards = computed(() => this.offerCards().length > 0);

  // Optional: derived state
  readonly isDone = computed(() => this.phase() === 'DONE');
  readonly canSend = computed(() => {
    const txt = this.input().trim();
    return txt.length > 0 && !this.sending() && !this.isDone();
  });

  // ====== Public actions ======
  constructor() {
    effect(() => {
      this.messages();
      this.quickReplies();
      this.scheduleScroll();
    });
    const first = this.messages()[0];
    if (first?.role === 'assistant') {
      this.scheduleReminder(first);
    }
  }

  ngAfterViewInit(): void {
    this.scheduleScroll();
  }

  newSession(): void {
    this.conversationId.set(null);
    this.error.set(null);
    this.input.set('');
    this.quickReplies.set([...INITIAL_OPTIONS]);
    this.inputType.set('text');
    this.phase.set(null);
    this.clearReminderTimer();
    this.reminderForAssistantId = null;
    const firstMessage: ChatMessage = {
      id: makeId(),
      role: 'assistant',
      text: INITIAL_PROMPT,
      ts: new Date(),
    };
    this.messages.set([firstMessage]);
    this.scheduleReminder(firstMessage);
  }

  onInputChange(value: string): void {
    this.input.set(value);
  }

  send(textOverride?: string): void {
    const text = this.normalizeMessageText((textOverride ?? this.input()).trim());
    if (!text || this.sending() || this.isDone()) return;

    this.error.set(null);
    this.sending.set(true);
    this.clearReminderTimer();
    this.reminderForAssistantId = null;

    // 1) Append user message
    this.messages.update((list) => [
      ...list,
      { id: makeId(), role: 'user', text: this.normalizeMessageText(text), ts: new Date() },
    ]);

    // 2) Clear input immediately
    this.input.set('');
    this.quickReplies.set([]);

    // 3) Build payload for backend
    const payload = {
      message: text,
      conversation_id: this.conversationId(), // keep session
    };

    // 4) Call backend (proxy /api/chat should forward to your real backend)
    this.chatApi
      .sendMessage(payload)
      .pipe(finalize(() => this.sending.set(false)))
      .subscribe({
        next: (res) => {
          // Store conversation id (critical)
          if (res?.conversation_id) {
            this.conversationId.set(res.conversation_id);
          }
          this.phase.set(res?.phase ?? null);

          // Append assistant message
          const reply = this.normalizeMessageText((res?.response ?? '').trim());
          if (reply) {
            this.addAssistantMessage(reply);
          } else {
            // Fallback so UI shows something if backend forgets "response"
            this.addAssistantMessage('(Aucune réponse du serveur)', false);
          }

          this.quickReplies.set(this.normalizeOptions(res?.options));
          this.inputType.set(this.normalizeInputType(res?.input_type));
        },
        error: (err: HttpErrorResponse) => {
          const msg =
            err?.error?.message ||
            err?.message ||
            "Échec de la requête. Vérifiez les logs backend et la config proxy.";
          this.error.set(msg);
          this.quickReplies.set([]);
          this.inputType.set('text');

          // Add an assistant error bubble so user sees it in chat
          this.messages.update((list) => [
            ...list,
            {
              id: makeId(),
              role: 'assistant',
              text: this.normalizeMessageText(`Erreur : ${msg}`),
              ts: new Date(),
            },
          ]);
        },
      });
  }

  sendQuickReply(option: string): void {
    if (!option || this.sending() || this.isDone()) return;
    this.send(option);
  }

  // For Enter to send (Shift+Enter for newline if you want)
  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  trackById = (_: number, m: ChatMessage) => m.id;

  private normalizeOptions(options?: ChatOption[]): string[] {
    if (!options || options.length === 0) return [];
    return options
      .map((option) => {
        if (typeof option === 'string') return option;
        if (option && typeof option === 'object') {
          return String(option.label ?? option.value ?? '').trim();
        }
        return String(option ?? '').trim();
      })
      .filter((option) => option.length > 0);
  }

  private normalizeInputType(value?: string): string {
    const allowed = new Set(['text', 'tel', 'email', 'number']);
    if (value && allowed.has(value)) return value;
    return 'text';
  }

  private addAssistantMessage(text: string, scheduleReminder = true): void {
    const message: ChatMessage = {
      id: makeId(),
      role: 'assistant',
      text: this.normalizeMessageText(text),
      ts: new Date(),
    };
    this.messages.update((list) => [...list, message]);
    if (scheduleReminder) {
      this.scheduleReminder(message);
    }
  }

  private scheduleReminder(message: ChatMessage): void {
    this.clearReminderTimer();
    if (this.isDone()) return;
    this.reminderTimer = setTimeout(() => {
      if (this.isDone() || this.sending()) return;
      if (this.reminderForAssistantId === message.id) return;
      const list = this.messages();
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx < 0) return;
      const hasUserAfter = list.slice(idx + 1).some((m) => m.role === 'user');
      if (hasUserAfter) return;
      this.reminderForAssistantId = message.id;
      this.requestReminder(message);
    }, REMINDER_DELAY_MS);
  }

  private clearReminderTimer(): void {
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  private requestReminder(message: ChatMessage): void {
    const payload = {
      conversation_id: this.conversationId(),
      last_assistant_message: message.text,
    };
    this.chatApi.sendReminder(payload).subscribe({
      next: (res) => {
        const reply = (res?.response ?? '').trim();
        if (reply) {
          this.addAssistantMessage(reply, false);
        }
      },
      error: () => {
        // Silently ignore reminder failures
      },
    });
  }

  private scheduleScroll(): void {
    setTimeout(() => this.scrollToBottom(), 0);
  }

  private scrollToBottom(): void {
    const el = this.chatScroll?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  private isOfferOptions(options: string[]): boolean {
    if (!options || options.length < 2) return false;
    return OFFER_NAMES.every((name) => options.includes(name));
  }

  private normalizeMessageText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length < 2) return text;
    const isQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
    const isSmartQuoted = trimmed.startsWith('“') && trimmed.endsWith('”');
    if (!isQuoted && !isSmartQuoted) return text;
    if (isQuoted) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') return parsed;
      } catch {
        // Ignore parse errors and fall back to slicing.
      }
    }
    return trimmed.slice(1, -1);
  }
}
