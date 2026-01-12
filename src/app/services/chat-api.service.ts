import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface ChatRequest {
  message: string;
  conversation_id?: string | null;
}

export interface ChatResponse {
  response: string;
  conversation_id: string;
  extracted_fields: Record<string, any>;
  completion_status: Record<string, boolean>;
  all_fields_complete: boolean;
  phase: string;
  options: any[];
  input_type: string;
}

@Injectable({ providedIn: 'root' })
export class ChatApiService {
  // With proxy: /api/... will be forwarded to http://localhost:8080
  private readonly baseUrl = '/api';

  constructor(private http: HttpClient) {}

  sendMessage(payload: ChatRequest): Observable<ChatResponse> {
    // Adjust path to match your Spring controller mapping
    return this.http.post<ChatResponse>(`${this.baseUrl}/chat`, payload);
  }
}
