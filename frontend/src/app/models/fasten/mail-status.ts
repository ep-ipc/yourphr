// Outbound mail, as Admin sees it (yourphr#536). Mirrors EmailManager.status() and SendResult.

export interface MailStatus {
  enabled: boolean;
  // 'console' writes to the server log; 'smtp' sends through the relay.
  provider: string;
  // The effective sender: smtp.from when set, else mail.from.
  from: string;
  // Present for the smtp provider. The password is never sent — only whether one is set.
  smtp?: {host: string; port: number; secure: boolean; user: string; passwordSet: boolean};
  // Where mail goes, in words.
  destination: string;
  // Each names a setting to fix. Empty when a message could be sent.
  problems: string[];
}

export interface MailSendResult {
  sent: boolean;
  provider: string;
  destination: string;
  reason?: string;
}
