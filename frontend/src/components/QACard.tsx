import { useId, useRef, useState } from "react";
import {
  Alert, Button, Card, Chip, CloseButton, Description, Fieldset, Form, InputGroup,
  Label, ListBox, Modal, Select, Separator, TextArea, TextField,
} from "@heroui/react";
import type { Member, NewQACard, QAAnswer, QACard as CardData } from "../api/types";
import { errorText } from "../lib/errorText";
import { MemberAvatar } from "./MemberAvatar";
import "./qa.css";

const letters = ["A", "B", "C", "D"] as const;
type SubmitAnswer = (index: number, answer: QAAnswer) => Promise<void>;

function AnswerOption({ marker, title, detail, selected, disabled, onPress }: {
  marker: string; title: string; detail?: string; selected: boolean; disabled: boolean; onPress(): void;
}) {
  return (
    <Button variant="secondary" className="qa-option" aria-pressed={selected}
      isDisabled={disabled} onPress={onPress}>
      <span className="qa-marker" aria-hidden="true">{marker}</span>
      <span className="qa-option-text">{title}{detail && <span className="qa-detail">{detail}</span>}</span>
      {selected && <span aria-hidden="true" className="qa-check">✓</span>}
    </Button>
  );
}

export function QACard({ card, recipient, onAnswer }: {
  card: CardData; recipient: string; onAnswer?: SubmitAnswer;
}) {
  const firstOpen = card.questions.findIndex(q => !q.answer);
  const [review, setReview] = useState<number | null>(null);
  const [direction, setDirection] = useState("next");
  const index = review ?? (firstOpen < 0 ? card.questions.length - 1 : firstOpen);
  const q = card.questions[index];
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const editable = !!onAnswer && (!q.answer || q.answer.choice === "skip");
  const draft = drafts[index];
  const enteringOther = editable && draft !== undefined;

  function move(to: number) {
    setDirection(to < index ? "previous" : "next");
    setReview(to);
    setError("");
  }

  async function submit(answer: QAAnswer) {
    if (!editable || !onAnswer || pending) return;
    setPending(true);
    setError("");
    setDirection("next");
    try {
      await onAnswer(index, answer);
      setDrafts(previous => {
        const next = { ...previous };
        delete next[index];
        return next;
      });
      if (index < card.questions.length - 1) setReview(index + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="qa-card" aria-label="QA 卡片">
      <Card.Header className="qa-meta">
        <Chip size="sm" variant="soft" color="accent">QA 卡片</Chip>
        <span className="qa-recipient" title={recipient}>@{recipient}</span>
      </Card.Header>
      <Card.Content key={index} className="qa-stage" data-direction={direction}>
        <Card.Title className="qa-prompt">{q.prompt}</Card.Title>
        <div className="qa-options">
          {q.options.map((option, i) => (
            <AnswerOption key={letters[i]} marker={letters[i]} title={option}
              selected={q.answer?.choice === letters[i]} disabled={!editable || pending}
              onPress={() => void submit({ choice: letters[i] })} />
          ))}
          <AnswerOption marker="✎" title="其他" selected={q.answer?.choice === "other" || enteringOther}
            detail={q.answer?.choice === "other" ? q.answer.text : undefined} disabled={!editable || pending}
            onPress={() => setDrafts(previous => ({ ...previous, [index]: previous[index] ?? "" }))} />
        </div>
        {enteringOther && (
          <Form className="qa-answer-form" onSubmit={e => {
            e.preventDefault();
            if (draft.trim()) void submit({ choice: "other", text: draft.trim() });
          }}>
            <TextField aria-label="自填答案" className="w-full" isDisabled={pending}
              value={draft} onChange={text => setDrafts(previous => ({ ...previous, [index]: text }))}>
              <TextArea autoFocus rows={2} maxLength={2000} placeholder="填写你的答案" />
            </TextField>
            <Button size="sm" type="submit" variant="primary" isDisabled={pending || !draft.trim()}>提交</Button>
          </Form>
        )}
      </Card.Content>
      <Separator />
      <Card.Footer className="qa-nav">
        <span aria-live="polite" className="qa-count">{index + 1} / {card.questions.length}{q.answer?.choice === "skip" && " · 已跳过"}</span>
        <div className="qa-controls">
          {editable && !q.answer && <Button size="sm" variant="ghost" isDisabled={pending} onPress={() => void submit({ choice: "skip" })}>跳过</Button>}
          {card.questions.length > 1 && <>
            <Button size="sm" variant="secondary" isDisabled={pending || index === 0} onPress={() => move(index - 1)}>上一题</Button>
            <Button size="sm" variant="secondary" isDisabled={pending || index === card.questions.length - 1} onPress={() => move(index + 1)}>下一题</Button>
          </>}
        </div>
      </Card.Footer>
      {error && <Alert status="danger"><Alert.Content>{error}</Alert.Content></Alert>}
    </Card>
  );
}

function blankQuestion() {
  return { id: crypto.randomUUID(), prompt: "", options: ["", ""] };
}

export function CreateQACard({ members, onSend, onClose }: {
  members: Member[]; onSend: (card: NewQACard, id: string) => Promise<void>; onClose: () => void;
}) {
  const formId = useId();
  const focusQuestion = useRef<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [questions, setQuestions] = useState(() => [blankQuestion()]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [id] = useState(() => crypto.randomUUID());
  const ready = !!recipient && questions.every(q => q.prompt.trim());

  function change(id: string, patch: Partial<NewQACard["questions"][number]>) {
    setQuestions(previous => previous.map(q => q.id === id ? { ...q, ...patch } : q));
  }

  async function send() {
    if (pending || !ready) return;
    setPending(true);
    setError("");
    try {
      await onSend({
        recipient_member_id: recipient,
        questions: questions.map(q => ({
          prompt: q.prompt.trim(), options: q.options.map(o => o.trim()).filter(Boolean),
        })),
      }, id);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={open => { if (!open && !pending) onClose(); }} className="z-40 bg-black/70">
      <Modal.Container placement="center" scroll="inside" className="p-3 sm:p-6">
        <Modal.Dialog aria-label="发送 QA 卡片" className="qa-dialog">
          <Modal.Header><Modal.Heading>发送 QA 卡片</Modal.Heading></Modal.Header>
          <Modal.CloseTrigger aria-label="关闭" isDisabled={pending} />
          <Modal.Body>
            <Form id={formId} className="qa-form" onSubmit={e => { e.preventDefault(); void send(); }}>
              <Select variant="secondary" value={recipient || null} isDisabled={pending} placeholder="选择成员或 Agent"
                onChange={key => setRecipient(key == null ? "" : String(key))}>
                <Label>回答人</Label>
                <Select.Trigger className="w-full"><Select.Value className="flex min-w-0 items-center gap-2 overflow-hidden" /><Select.Indicator /></Select.Trigger>
                <Select.Popover className="z-50">
                  <ListBox aria-label="回答人">
                    {members.map(m => (
                      <ListBox.Item key={m.id} id={m.id} textValue={m.display_name}>
                        <MemberAvatar member={m} size={24} /><span className="min-w-0 truncate">{m.display_name}</span>
                        {m.type === "bot" && <Chip size="sm">Agent</Chip>}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {questions.map((q, i) => (
                <Fieldset key={q.id} className="qa-question" disabled={pending}>
                  <Fieldset.Legend className="qa-legend">问题 {i + 1}</Fieldset.Legend>
                  <Fieldset.Group className="qa-fields">
                    <TextField aria-label={`问题 ${i + 1}`} isRequired value={q.prompt} onChange={prompt => change(q.id, { prompt })}>
                      <TextArea rows={2} maxLength={500} placeholder="写下问题" ref={element => {
                        if (element && focusQuestion.current === q.id) {
                          focusQuestion.current = null;
                          element.focus();
                        }
                      }} />
                    </TextField>
                    {q.options.map((option, j) => (
                      <TextField key={j} aria-label={`问题 ${i + 1} 选项 ${letters[j]}`} value={option}
                        onChange={text => change(q.id, { options: q.options.map((o, k) => k === j ? text : o) })}>
                        <InputGroup fullWidth>
                          <InputGroup.Prefix className="qa-letter">{letters[j]}</InputGroup.Prefix>
                          <InputGroup.Input maxLength={160} placeholder="填写选项" />
                          <InputGroup.Suffix>
                            <CloseButton aria-label={`删除选项 ${letters[j]}`} onPress={() => change(q.id, { options: q.options.filter((_, k) => k !== j) })} />
                          </InputGroup.Suffix>
                        </InputGroup>
                      </TextField>
                    ))}
                    <Description>其他 · 由回答人自行填写</Description>
                    <Fieldset.Actions className="qa-question-actions">
                      <Button size="sm" variant="secondary" isDisabled={pending || q.options.length >= letters.length}
                        onPress={() => change(q.id, { options: [...q.options, ""] })}>添加选项</Button>
                      {questions.length > 1 && <Button size="sm" variant="ghost" isDisabled={pending}
                        onPress={() => setQuestions(previous => previous.filter(item => item.id !== q.id))}>删除问题</Button>}
                    </Fieldset.Actions>
                  </Fieldset.Group>
                </Fieldset>
              ))}
              {error && <Alert status="danger"><Alert.Content>{error}</Alert.Content></Alert>}
            </Form>
          </Modal.Body>
          <Modal.Footer className="qa-actions">
            <Button variant="secondary" isDisabled={pending || questions.length >= 64}
              onPress={() => {
                const question = blankQuestion();
                focusQuestion.current = question.id;
                setQuestions(previous => [...previous, question]);
              }}>添加问题</Button>
            <Button type="submit" form={formId} variant="primary" isPending={pending} isDisabled={!ready}>发送卡片</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
