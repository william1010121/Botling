// The words for a message whose delivery could not be confirmed (no answer came; the chat could not be checked).
// Shared by the phone's transports (desktop/mobile) and the renderer (App.tsx), which shows such a failure as the
// composer's "unconfirmed" state (keep the draft, check the chat) instead of "Not sent".
export const DELIVERY_UNCONFIRMED = 'Your computer has not confirmed this message. It may still arrive: check the chat before sending it again.';
