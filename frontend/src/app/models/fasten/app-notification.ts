// A notification as the signed-in person sees it (#793). Mirrors GET /api/secure/notifications.

export interface AppNotification {
  id: string;
  type: 'maintenance' | 'system' | 'user';
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error' | 'success';
  created_at: string;
  expires_at: string | null;
}
