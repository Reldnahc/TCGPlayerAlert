import type { ComponentChildren, ComponentProps } from "preact";
import { Icon, type IconName } from "./Icon.js";

type ButtonTone = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  children,
  tone = "secondary",
  icon,
  busy = false,
  class: className = "",
  ...properties
}: Omit<ComponentProps<"button">, "class"> & {
  readonly class?: string;
  readonly tone?: ButtonTone;
  readonly icon?: IconName;
  readonly busy?: boolean;
}) {
  return (
    <button
      {...properties}
      class={`button button--${tone}${className === "" ? "" : ` ${className}`}`}
      disabled={properties.disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {icon === undefined ? null : <Icon name={icon} size={16} />}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  label,
  icon,
  ...properties
}: Omit<ComponentProps<"button">, "aria-label"> & {
  readonly label: string;
  readonly icon: IconName;
}) {
  return (
    <button
      {...properties}
      class="icon-button"
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  class: className = "",
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ComponentChildren;
  readonly class?: string;
}) {
  return (
    <label class={`field${className === "" ? "" : ` ${className}`}`}>
      <span class="field__label">{label}</span>
      {children}
      {hint === undefined ? null : <span class="field__hint">{hint}</span>}
    </label>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label class={`toggle-row${disabled ? " is-disabled" : ""}`}>
      <span class="toggle-row__copy">
        <strong>{label}</strong>
        {description === undefined ? null : <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span class="toggle" aria-hidden="true" />
    </label>
  );
}

export function StatusBadge({ status }: { readonly status: string }) {
  const normalized = status.toLocaleLowerCase().replaceAll(" ", "-");
  return (
    <span class={`status status--${normalized}`}>
      {status.replaceAll("-", " ")}
    </span>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  readonly tone?: "info" | "success" | "warning" | "danger";
  readonly children: ComponentChildren;
}) {
  return (
    <div
      class={`notice notice--${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: string;
}) {
  return (
    <div class="empty-state">
      <strong>{title}</strong>
      {detail === undefined ? null : <p>{detail}</p>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ComponentChildren;
}) {
  return (
    <header class="page-header">
      <div>
        <h1>{title}</h1>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : (
        <div class="page-header__actions">{actions}</div>
      )}
    </header>
  );
}

export function Toolbar({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  return <div class="toolbar">{children}</div>;
}

export function Metric({
  label,
  value,
  detail,
  actionLabel,
  onClick,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
  readonly actionLabel?: string | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail === undefined ? null : <small>{detail}</small>}
    </>
  );
  return onClick === undefined ? (
    <div class="metric">{content}</div>
  ) : (
    <button
      type="button"
      class="metric metric--action"
      aria-label={actionLabel ?? label}
      onClick={onClick}
    >
      {content}
      <Icon name="chevron-right" size={15} />
    </button>
  );
}

export function Spinner({ label = "Loading" }: { readonly label?: string }) {
  return (
    <span class="spinner" role="status">
      <span class="spinner__mark" />
      {label}
    </span>
  );
}
