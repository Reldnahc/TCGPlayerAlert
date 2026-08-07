import { Icon } from "./Icon.js";
import { useToast } from "../state/ToastContext.js";

export function ToastViewport() {
  const { messages, dismiss } = useToast();
  return (
    <div class="toast-viewport" aria-live="polite">
      {messages.map((message) => (
        <div key={message.id} class={`toast toast--${message.tone}`}>
          <span>{message.text}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(message.id)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
