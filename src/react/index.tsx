"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DialogField, Form } from "../types.js";

/**
 * Button and dialog, rendering the fields declared by the form.
 *
 * ## Unstyled by design
 *
 * A component library that imposes its own styling has to be fought. Every
 * element carries a `data-edw` attribute and accepts an external class, so
 * the host application styles it with its own design system.
 *
 * ## No server calls
 *
 * `onSubmit` is supplied by the host and targets its own route, where its
 * authorization lives. A UI component issuing API calls would need to know
 * about authentication, which is out of its scope.
 */

export type SubmitResult = { sent: boolean; error?: string | null };

export function WhatsAppFormButton({
  form,
  onSubmit,
  classNames,
  children,
}: {
  form: Form;
  /** Posts the values to your server and reports whether the message was sent. */
  onSubmit: (values: Record<string, string>) => Promise<SubmitResult>;
  classNames?: Partial<
    Record<
      | "button"
      | "overlay"
      | "dialog"
      | "title"
      | "description"
      | "field"
      | "label"
      | "help"
      | "error"
      | "success"
      | "actions"
      | "submit"
      | "cancel",
      string
    >
  >;
  /** Rendered before the button label — an icon, for instance. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  function close() {
    setOpen(false);
    setValues({});
    setError(null);
    setResult(null);
    setSubmitting(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      setResult(await onSubmit(values));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" data-edw="button" className={classNames?.button} onClick={() => setOpen(true)}>
        {children}
        {form.button}
      </button>

      {open ? (
        <Dialog
          title={result ? "Done" : (form.title ?? form.button)}
          description={result ? undefined : form.description}
          onClose={close}
          classNames={classNames}
        >
          {result ? (
            <div data-edw="result">
              {result.sent ? (
                <p data-edw="success" className={classNames?.success}>
                  Message sent. The recipient can now reply in that thread.
                </p>
              ) : (
                <>
                  <p data-edw="error" className={classNames?.error}>
                    The case was created, but the message could not be sent.
                  </p>
                  {/* Meta's message verbatim: it states whether the template is
                      unapproved, the number is outside the test list, or the
                      token expired. A generic failure cannot be acted upon. */}
                  {result.error ? <p data-edw="detail">{result.error}</p> : null}
                </>
              )}
              <div data-edw="actions" className={classNames?.actions}>
                <button type="button" className={classNames?.cancel} onClick={close}>
                  Close
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} data-edw="form">
              {form.fields.map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ""}
                  onChange={(v) => setValues((x) => ({ ...x, [field.key]: v }))}
                  classNames={classNames}
                />
              ))}

              {error ? (
                <p role="alert" data-edw="error" className={classNames?.error}>
                  {error}
                </p>
              ) : null}

              <div data-edw="actions" className={classNames?.actions}>
                <button type="button" className={classNames?.cancel} onClick={close}>
                  Cancel
                </button>
                <button type="submit" disabled={submitting} className={classNames?.submit}>
                  {submitting ? "Sending…" : "Send via WhatsApp"}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

function Field({
  field,
  value,
  onChange,
  classNames,
}: {
  field: DialogField;
  value: string;
  onChange: (v: string) => void;
  classNames?: Record<string, string | undefined>;
}) {
  const id = `edw-${field.key}`;
  const shared = {
    id,
    value,
    required: field.required,
    placeholder: field.placeholder,
    maxLength: field.maxLength,
    "aria-describedby": field.help ? `${id}-help` : undefined,
    className: classNames?.field,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <div data-edw="field" data-edw-type={field.type}>
      <label htmlFor={id} data-edw="label" className={classNames?.label}>
        {field.label}
      </label>
      {field.type === "textarea" ? (
        <textarea {...shared} rows={3} />
      ) : (
        <input {...shared} inputMode={field.type === "phone" ? "tel" : undefined} />
      )}
      {field.help ? (
        <p id={`${id}-help`} data-edw="help" className={classNames?.help}>
          {field.help}
        </p>
      ) : null}
    </div>
  );
}

function Dialog({
  title,
  description,
  onClose,
  classNames,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  classNames?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  /**
   * `onClose` is held in a ref and the focus effect declares no dependencies.
   *
   * Consumers pass inline arrow functions, which are a new reference on every
   * render. With `onClose` in the dependency array the effect re-runs on each
   * keystroke and `box.current?.focus()` moves focus out of the input being
   * typed into — one character per focus. Observed and measured in the
   * originating project.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-edw="overlay" className={classNames?.overlay}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-edw="dialog"
        className={classNames?.dialog}
      >
        <h2 data-edw="title" className={classNames?.title}>
          {title}
        </h2>
        {description ? (
          <p data-edw="description" className={classNames?.description}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
