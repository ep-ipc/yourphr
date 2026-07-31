/**
 * Plain-language pre-connect copy for Medicare / Blue Button-class sources (#430).
 * Shown only after PP/ToS consent (#427); not a substitute for Privacy Policy.
 */
export const MEDICARE_PRE_CONNECT = {
  title: 'Connect Medicare',
  intro:
    'You are about to sign in with Medicare and allow this YourPHR instance to read claims-related records you authorize.',
  bullets: [
    'You sign in with Medicare / CMS — YourPHR never asks for your Medicare.gov password.',
    'This app requests read access to data such as coverage and claims (ExplanationOfBenefit), as authorized.',
    'Records are stored on this YourPHR server (the instance you use), not sent to the open-source project maintainers.',
    'You can disconnect later; data already imported stays until you or the operator delete it.',
    'YourPHR is for viewing and organizing records — it is not medical advice.',
  ],
  continueLabel: 'Continue to Medicare sign-in',
  cancelLabel: 'Cancel',
};
