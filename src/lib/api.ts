
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const API_BASE = (import.meta.env as Record<string, any>).VITE_API_BASE_URL || 'http://localhost:5000/api';

function getAuthToken(): string | null {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  path: string,
  method: HttpMethod,
  body?: unknown,
  customHeaders?: Record<string, string>
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(customHeaders || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });

  if (!res.ok) {
    let message = 'Request failed';
    try {
      const err = await res.json();
      message = err?.error?.message || err?.message || message;
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/* ----------------- existing APIs (unchanged) ----------------- */
export const AuthAPI = {
  register(payload: { firstName: string; lastName: string; email: string; password: string; phone?: string; }): Promise<{ success: boolean; data: { user: any; token: string } }> {
    return apiRequest('/auth/register', 'POST', payload);
  },
  login(payload: { email: string; password: string }): Promise<{ success: boolean; data: { user: any; token: string } }> {
    return apiRequest('/auth/login', 'POST', payload);
  },
  me(): Promise<{ success: boolean; data: { user: any } }> {
    return apiRequest('/auth/me', 'GET');
  },
};

export const ContactAPI = {
  getContacts(): Promise<{ success: boolean; data: { contacts: any[] } }> {
    return apiRequest('/contacts', 'GET');
  },
  createContact(payload: {
    contactType: string;
    firstName: string;
    lastName: string;
    relationship: string;
    email: string;
    phone: string;
    isPrimary?: boolean;
  }): Promise<{ success: boolean; data: { contact: any } }> {
    return apiRequest('/contacts', 'POST', payload);
  },
  updateContact(id: string, payload: any): Promise<{ success: boolean; data: { contact: any } }> {
    return apiRequest(`/contacts/${id}`, 'PUT', payload);
  },
  deleteContact(id: string): Promise<{ success: boolean }> {
    return apiRequest(`/contacts/${id}`, 'DELETE');
  },
};

export const AlertAPI = {
  getAlerts(): Promise<{ success: boolean; data: { alerts: any[] } }> {
    return apiRequest('/alerts', 'GET');
  },
  sendWatchTest(): Promise<{ success: boolean; result?: any }> {
    return apiRequest('/alerts/push-test', 'POST');
  },
  triggerSOS(payload: { location?: string; includeEmergencyCall?: boolean; }): Promise<{ success: boolean; data: { alert: any; sosResult: any; emergencyCallResult: any; contactResults: any[] } }> {
    return apiRequest('/alerts/sos', 'POST', payload);
  },
  triggerEmergencyCall(payload: { location?: string; }): Promise<{ success: boolean; data: { alert: any; emergencyCallResult: any; contactResults: any[] } }> {
    return apiRequest('/alerts/emergency-call', 'POST', payload);
  },
};

/* ----------------- NEW: Monitoring API ----------------- */
export const MonitoringAPI = {
  startSession(payload: {
    deviceInfo: { deviceId: string; deviceType: string; location?: string };
    aiAnalysis?: { confidence?: number };
    privacySettings?: { videoRecording?: boolean; dataRetention?: number; anonymization?: boolean };
  }): Promise<{ success: boolean; data: { monitoring: any; sessionId: string } }> {
    return apiRequest('/monitoring/start', 'POST', payload);
  },

  stopSession(sessionId: string): Promise<{ success: boolean; data: { monitoring: any } }> {
    return apiRequest(`/monitoring/stop/${encodeURIComponent(sessionId)}`, 'PUT');
  },

  /** fast path used by LiveMonitor to send FALL/INACTIVITY/NORMAL */
  postEvent(payload: {
    sessionId: string;
    type: 'FALL' | 'INACTIVITY' | 'NORMAL' | string;
    confidence?: number;
    durationMs?: number;
    location?: string;
    coordinates?: { lat?: number; lng?: number; x?: number; y?: number; bbox?: any };
    modelVersion?: string;
  }): Promise<{ success: true; data: { danger: boolean; alertId?: string; thresholds: { inactivityMs: number } } }> {
    return apiRequest('/monitoring/event', 'POST', payload);
  },

  getConfig(): Promise<{ success: true; data: { inactivityThresholdMs: number; cooldownMs: number } }> {
    return apiRequest('/monitoring/config', 'GET');
  },
};