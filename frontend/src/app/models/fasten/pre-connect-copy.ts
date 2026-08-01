/**
 * Modular pre-connect informed messaging for catalog medical-record connects.
 * Profile comes from the backend connection policy (auto/generic/medicare/none).
 */

export type PreConnectProfile = 'none' | 'generic' | 'medicare';

export interface PreConnectCopy {
  title: string;
  intro: string;
  bullets: string[];
  continueLabel: string;
  cancelLabel: string;
  /** Show CMS Blue Button attribution block under the bullets. */
  showMedicareAttribution: boolean;
}

export const GENERIC_PRE_CONNECT: PreConnectCopy = {
  title: 'Connect medical records',
  intro:
    'You are about to sign in with your healthcare provider and allow this YourPHR instance to read health records you authorize.',
  bullets: [
    'You sign in with that provider — YourPHR never asks for your provider password on this form.',
    'This app requests read access to the health records in the scopes you authorize.',
    'Records are stored on this YourPHR server (the instance you use), not sent to the open-source project maintainers.',
    'You can disconnect later from Connected Sources (stop tokens) without wiping records, or remove imported data as a separate choice.',
    'YourPHR is for viewing and organizing records — it is not medical advice.',
  ],
  continueLabel: 'Continue to provider sign-in',
  cancelLabel: 'Cancel',
  showMedicareAttribution: false,
};

export const MEDICARE_PRE_CONNECT: PreConnectCopy = {
  title: 'Connect Medicare',
  intro:
    'You are about to sign in with Medicare and allow this YourPHR instance to read claims-related records you authorize.',
  bullets: [
    'You sign in with Medicare / CMS — YourPHR never asks for your Medicare.gov password.',
    'This app requests read access to data such as coverage and claims (ExplanationOfBenefit), as authorized.',
    'Records are stored on this YourPHR server (the instance you use), not sent to the open-source project maintainers.',
    'You can disconnect later from Connected Sources (stop tokens) without wiping records, or remove imported data as a separate choice.',
    'YourPHR is for viewing and organizing records — it is not medical advice.',
  ],
  continueLabel: 'Continue to Medicare sign-in',
  cancelLabel: 'Cancel',
  showMedicareAttribution: true,
};

export function preConnectCopyForProfile(profile: string | undefined): PreConnectCopy | null {
  switch ((profile || '').toLowerCase()) {
    case 'none':
      return null;
    case 'medicare':
      return MEDICARE_PRE_CONNECT;
    case 'generic':
    default:
      return GENERIC_PRE_CONNECT;
  }
}
