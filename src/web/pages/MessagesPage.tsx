import { useEffect, useRef, useState } from "preact/hooks";
import { UiApiError, uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Spinner,
  Toolbar,
} from "../components/ui.js";
import type {
  MessagesPage as MessagesPageData,
  MessageThread,
} from "../contracts.js";
import { useMessages } from "../state/MessagesContext.js";
import { compactDate, dateTime, errorMessage } from "../utils.js";

export function MessagesPage() {
  const [page, setPage] = useState(1);
  const [orderDraft, setOrderDraft] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [data, setData] = useState<MessagesPageData | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [threadPage, setThreadPage] = useState(1);
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState("");
  const [threadError, setThreadError] = useState("");
  const [readError, setReadError] = useState("");
  const [markingRead, setMarkingRead] = useState(false);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [bulkNotice, setBulkNotice] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [replyNotice, setReplyNotice] = useState("");
  const [replyUncertain, setReplyUncertain] = useState(false);
  const selectedThreadIdRef = useRef<number | null>(null);
  const automaticReadAttemptsRef = useRef(new Set<string>());
  const { setUnreadCount } = useMessages();
  const selectedSummary = data?.threads.find(
    (candidate) => candidate.threadId === selectedThreadId,
  );

  async function load(force = false, signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const result = await uiApi.messages(
        page,
        orderNumber,
        includeDeleted,
        force,
        signal,
      );
      if (signal?.aborted === true) return;
      setData(result);
      setUnreadCount(result.unreadCount);
      setSelectedThreadId((current) => {
        if (result.threads.some((candidate) => candidate.threadId === current))
          return current;
        return result.threads[0]?.threadId ?? null;
      });
    } catch (cause) {
      if (signal?.aborted !== true) {
        setError(errorMessage(cause, "Messages could not be loaded."));
      }
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }

  async function loadThread(force = false, signal?: AbortSignal) {
    if (selectedThreadId === null) {
      setThread(null);
      return false;
    }
    setThreadLoading(true);
    setThreadError("");
    setReadError("");
    try {
      const result = await uiApi.message(
        selectedThreadId,
        threadPage,
        force,
        signal,
      );
      if (signal?.aborted !== true) {
        setThread(result);
        return true;
      }
    } catch (cause) {
      if (signal?.aborted !== true) {
        setThreadError(
          errorMessage(cause, "The conversation could not be loaded."),
        );
      }
    } finally {
      if (signal?.aborted !== true) setThreadLoading(false);
    }
    return false;
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [page, orderNumber, includeDeleted]);

  useEffect(() => {
    const controller = new AbortController();
    void loadThread(false, controller.signal);
    return () => controller.abort();
  }, [selectedThreadId, threadPage]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    const unreadMessageCount = selectedSummary?.unreadMessageCount ?? 0;
    if (thread?.threadId !== selectedThreadId || unreadMessageCount < 1) {
      return;
    }
    const attemptKey = [
      thread.threadId,
      thread.totalMessageCount,
      unreadMessageCount,
    ].join(":");
    if (automaticReadAttemptsRef.current.has(attemptKey)) return;
    automaticReadAttemptsRef.current.add(attemptKey);
    void markThreadRead(thread.threadId);
  }, [
    selectedSummary?.unreadMessageCount,
    selectedThreadId,
    thread?.threadId,
    thread?.totalMessageCount,
  ]);

  function applyOrderSearch() {
    setPage(1);
    setOrderNumber(orderDraft.trim());
  }

  function selectThread(threadId: number) {
    selectedThreadIdRef.current = threadId;
    setSelectedThreadId(threadId);
    setThreadPage(1);
    setThread(null);
    setReadError("");
    setReplyDraft("");
    setReplyError("");
    setReplyNotice("");
    setReplyUncertain(false);
  }

  async function markThreadRead(threadId = thread?.threadId) {
    if (
      threadId === undefined ||
      markingRead ||
      markingAllRead ||
      sendingReply
    ) {
      return;
    }
    setMarkingRead(true);
    setReadError("");
    try {
      await uiApi.markMessageThreadRead(threadId);
      const previouslyUnread =
        data?.threads.find((candidate) => candidate.threadId === threadId)
          ?.unreadMessageCount ?? 0;
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              unreadCount: Math.max(0, current.unreadCount - previouslyUnread),
              threads: current.threads.map((candidate) =>
                candidate.threadId === threadId
                  ? { ...candidate, unreadMessageCount: 0 }
                  : candidate,
              ),
            },
      );
      setThread((current) =>
        current?.threadId !== threadId
          ? current
          : {
              ...current,
              messages: current.messages.map((message) => ({
                ...message,
                isRead: true,
              })),
            },
      );
      if (data !== null) {
        setUnreadCount(Math.max(0, data.unreadCount - previouslyUnread));
      }
    } catch (cause) {
      if (selectedThreadIdRef.current === threadId) {
        setReadError(
          errorMessage(cause, "The conversation could not be marked read."),
        );
      }
    } finally {
      setMarkingRead(false);
    }
  }

  async function markAllRead() {
    if (
      markingAllRead ||
      markingRead ||
      sendingReply ||
      data === null ||
      data.unreadCount < 1
    ) {
      return;
    }
    setMarkingAllRead(true);
    setBulkError("");
    setBulkNotice("");
    try {
      const result = await uiApi.markAllMessageThreadsRead();
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              unreadCount: 0,
              threads: current.threads.map((candidate) => ({
                ...candidate,
                unreadMessageCount: 0,
              })),
            },
      );
      setThread((current) =>
        current === null
          ? current
          : {
              ...current,
              messages: current.messages.map((message) => ({
                ...message,
                isRead: true,
              })),
            },
      );
      setUnreadCount(0);
      setReadError("");
      setBulkNotice(
        result.markedThreadCount === 0
          ? "All inbox conversations are already read."
          : `Marked ${String(result.markedThreadCount)} conversation${result.markedThreadCount === 1 ? "" : "s"} read.`,
      );
    } catch (cause) {
      setBulkError(
        errorMessage(cause, "All conversations could not be marked read."),
      );
      void load(true);
    } finally {
      setMarkingAllRead(false);
    }
  }

  async function sendReply() {
    if (thread === null || sendingReply || replyUncertain) return;
    const threadId = thread.threadId;
    const body = replyDraft.trim();
    if (body === "") {
      setReplyError("Write a reply before sending.");
      return;
    }
    setSendingReply(true);
    setReplyError("");
    setReplyNotice("");
    try {
      await uiApi.replyToMessageThread(threadId, body);
      if (selectedThreadIdRef.current !== threadId) return;
      setReplyDraft("");
      setReplyNotice("Message sent.");
      void loadThread(true);
    } catch (cause) {
      if (selectedThreadIdRef.current !== threadId) return;
      if (cause instanceof UiApiError && cause.code === "AMBIGUOUS_RESULT") {
        setReplyUncertain(true);
        setReplyError(
          "TCGplayer may have received this message. Refresh the conversation before deciding whether to send it again.",
        );
      } else {
        setReplyError(errorMessage(cause, "The message could not be sent."));
      }
    } finally {
      setSendingReply(false);
    }
  }

  return (
    <main class="page">
      <PageHeader
        title="Messages"
        description="TCGplayer buyer conversations"
        actions={
          <>
            <a
              class="button button--secondary"
              href={
                data?.portalUrl ?? "https://sellerportal.tcgplayer.com/messages"
              }
              target="_blank"
              rel="noreferrer"
            >
              Open TCGplayer
            </a>
            <Button
              busy={markingAllRead}
              disabled={
                markingAllRead ||
                markingRead ||
                sendingReply ||
                data === null ||
                data.unreadCount < 1
              }
              onClick={() => void markAllRead()}
            >
              Mark all read
            </Button>
            <Button
              icon="refresh"
              busy={loading || threadLoading || markingAllRead}
              onClick={() => {
                void load(true);
                void loadThread(true);
              }}
            >
              Refresh
            </Button>
          </>
        }
      />
      <div class="page-body messages-layout">
        <Toolbar>
          <Field label="Order number" class="messages-order-filter">
            <input
              value={orderDraft}
              placeholder="Search an order"
              onInput={(event) => setOrderDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyOrderSearch();
              }}
            />
          </Field>
          <Button icon="search" onClick={applyOrderSearch}>
            Search
          </Button>
          {orderNumber === "" ? null : (
            <Button
              tone="quiet"
              onClick={() => {
                setOrderDraft("");
                setOrderNumber("");
                setPage(1);
              }}
            >
              Clear
            </Button>
          )}
          <Field label="View" class="messages-view-filter">
            <select
              value={includeDeleted ? "all" : "active"}
              onChange={(event) => {
                setIncludeDeleted(event.currentTarget.value === "all");
                setPage(1);
              }}
            >
              <option value="active">Inbox</option>
              <option value="all">Include deleted</option>
            </select>
          </Field>
          <span class="toolbar__spacer" />
          <span class="muted">
            {data === null
              ? ""
              : `${String(data.totalThreads)} conversation${data.totalThreads === 1 ? "" : "s"} · updated ${dateTime(data.fetchedAt)}`}
          </span>
        </Toolbar>

        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
        {bulkError === "" ? null : <Notice tone="danger">{bulkError}</Notice>}
        {bulkNotice === "" ? null : (
          <Notice tone="success">{bulkNotice}</Notice>
        )}

        <div class="messages-workspace">
          <section class="message-list" aria-label="Conversations">
            {loading && data === null ? (
              <div class="empty-state">
                <Spinner label="Loading messages" />
              </div>
            ) : data === null || data.threads.length === 0 ? (
              <EmptyState
                title="No messages found"
                detail={
                  orderNumber === ""
                    ? "Your inbox is empty."
                    : "No conversation matches that order."
                }
              />
            ) : (
              <div class="message-list__rows">
                {data.threads.map((candidate) => (
                  <button
                    key={candidate.threadId}
                    type="button"
                    class={`message-thread-row${candidate.threadId === selectedThreadId ? " is-selected" : ""}${candidate.unreadMessageCount > 0 ? " is-unread" : ""}`}
                    aria-pressed={candidate.threadId === selectedThreadId}
                    disabled={markingRead || markingAllRead || sendingReply}
                    onClick={() => selectThread(candidate.threadId)}
                  >
                    <span class="message-thread-row__topline">
                      <strong>{candidate.subject}</strong>
                      {candidate.unreadMessageCount > 0 ? (
                        <i
                          aria-label={`${String(candidate.unreadMessageCount)} unread`}
                        >
                          {candidate.unreadMessageCount > 99
                            ? "99+"
                            : String(candidate.unreadMessageCount)}
                        </i>
                      ) : null}
                    </span>
                    <span>
                      {candidate.senderDisplayName} ·{" "}
                      {compactDate(candidate.createdAt)}
                    </span>
                    <small>
                      {candidate.orderNumber === ""
                        ? candidate.orderStatus
                        : `${candidate.orderNumber} · ${candidate.orderStatus}`}
                    </small>
                  </button>
                ))}
              </div>
            )}
            <div class="messages-pagination">
              <Button
                icon="chevron-left"
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <span>
                Page {String(data?.page ?? page)} of{" "}
                {String(data?.totalPages ?? 1)}
              </span>
              <Button
                icon="chevron-right"
                disabled={
                  loading || data === null || data.page >= data.totalPages
                }
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </section>

          <section class="message-detail" aria-label="Conversation">
            {selectedThreadId === null ? (
              <EmptyState title="Select a conversation" />
            ) : threadLoading && thread === null ? (
              <div class="empty-state">
                <Spinner label="Loading conversation" />
              </div>
            ) : threadError !== "" ? (
              <Notice tone="danger">{threadError}</Notice>
            ) : thread === null ? (
              <EmptyState title="Conversation unavailable" />
            ) : (
              <>
                <header class="message-detail__header">
                  <div class="message-detail__heading">
                    <h2>{thread.subject}</h2>
                    <span>
                      {thread.orderNumber === ""
                        ? "No linked order"
                        : `Order ${thread.orderNumber}`}
                    </span>
                  </div>
                  <div class="message-detail__actions">
                    <Button
                      busy={markingRead}
                      disabled={
                        markingRead ||
                        markingAllRead ||
                        (selectedSummary?.unreadMessageCount ?? 0) === 0
                      }
                      onClick={() => void markThreadRead()}
                    >
                      {(selectedSummary?.unreadMessageCount ?? 0) === 0
                        ? "Read"
                        : "Mark read"}
                    </Button>
                    <a
                      class="button button--secondary"
                      href={thread.portalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open conversation
                    </a>
                  </div>
                </header>
                <div class="message-detail__note">
                  <span>Opening an unread conversation marks it read</span>
                  {readError === "" ? null : (
                    <span class="message-detail__read-error" role="alert">
                      {readError}
                    </span>
                  )}
                </div>
                <ol class="message-stack">
                  {thread.messages.map((message) => (
                    <li
                      key={message.messageId}
                      class={
                        message.senderDisplayName === "You" ? "is-mine" : ""
                      }
                    >
                      <header>
                        <strong>{message.senderDisplayName}</strong>
                        <span>{dateTime(message.createdAt)}</span>
                      </header>
                      <p>{message.body}</p>
                    </li>
                  ))}
                </ol>
                <form
                  class="message-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendReply();
                  }}
                >
                  {replyError === "" ? null : (
                    <Notice tone={replyUncertain ? "warning" : "danger"}>
                      <strong>
                        {replyUncertain
                          ? "Delivery needs verification"
                          : "Message not sent"}
                      </strong>
                      <span>{replyError}</span>
                      {replyUncertain ? (
                        <Button
                          type="button"
                          busy={threadLoading}
                          onClick={() => {
                            void loadThread(true).then((refreshed) => {
                              if (!refreshed) return;
                              setReplyUncertain(false);
                              setReplyError("");
                            });
                          }}
                        >
                          Refresh conversation
                        </Button>
                      ) : null}
                    </Notice>
                  )}
                  {replyNotice === "" ? null : (
                    <Notice tone="success">{replyNotice}</Notice>
                  )}
                  <Field label="Reply" hint="Sent directly to the buyer">
                    <textarea
                      aria-label="Reply"
                      value={replyDraft}
                      maxLength={10_000}
                      rows={4}
                      disabled={
                        thread.deleted ||
                        markingAllRead ||
                        sendingReply ||
                        replyUncertain
                      }
                      placeholder={
                        thread.deleted
                          ? "Deleted conversations cannot be replied to"
                          : "Write a reply"
                      }
                      onInput={(event) => {
                        setReplyDraft(event.currentTarget.value);
                        setReplyError("");
                        setReplyNotice("");
                      }}
                    />
                  </Field>
                  <div class="message-reply__actions">
                    <span>{replyDraft.length.toLocaleString()} / 10,000</span>
                    <Button
                      type="submit"
                      tone="primary"
                      busy={sendingReply}
                      disabled={
                        thread.deleted ||
                        markingAllRead ||
                        sendingReply ||
                        replyUncertain ||
                        replyDraft.trim() === ""
                      }
                    >
                      Send message
                    </Button>
                  </div>
                </form>
                <div class="message-detail__pagination">
                  <Button
                    icon="chevron-left"
                    disabled={threadPage <= 1 || threadLoading}
                    onClick={() =>
                      setThreadPage((current) => Math.max(1, current - 1))
                    }
                  >
                    Newer
                  </Button>
                  <span>
                    Page {String(thread.page)} of {String(thread.totalPages)}
                  </span>
                  <Button
                    icon="chevron-right"
                    disabled={threadLoading || thread.page >= thread.totalPages}
                    onClick={() => setThreadPage((current) => current + 1)}
                  >
                    Older
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
