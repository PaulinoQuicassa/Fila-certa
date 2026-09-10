import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseIncoming } from "./parseIncoming.ts";

Deno.test("parseIncoming: mensagem de texto simples", () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: "Maria" } }],
          messages: [{ from: "244912345678", id: "wamid.1", type: "text", text: { body: "Olá" } }],
        },
      }],
    }],
  };
  const result = parseIncoming(payload);
  assertEquals(result, { from: "244912345678", messageId: "wamid.1", profileName: "Maria", replyId: undefined, text: "Olá" });
});

Deno.test("parseIncoming: resposta a botão interactive", () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: "244912345678",
            id: "wamid.2",
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: "WELCOME_JOIN", title: "Entrar na fila" } },
          }],
        },
      }],
    }],
  };
  const result = parseIncoming(payload);
  assertEquals(result?.replyId, "WELCOME_JOIN");
});

Deno.test("parseIncoming: resposta a lista interactive", () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: "244912345678",
            id: "wamid.3",
            type: "interactive",
            interactive: { type: "list_reply", list_reply: { id: "INST_siac", title: "SIAC" } },
          }],
        },
      }],
    }],
  };
  const result = parseIncoming(payload);
  assertEquals(result?.replyId, "INST_siac");
});

Deno.test("parseIncoming: notificação de estado de entrega (sem messages) devolve null", () => {
  const payload = {
    entry: [{
      changes: [{
        value: { statuses: [{ id: "wamid.4", status: "delivered" }] },
      }],
    }],
  };
  assertEquals(parseIncoming(payload), null);
});

Deno.test("parseIncoming: payload malformado devolve null em vez de rebentar", () => {
  assertEquals(parseIncoming({}), null);
  assertEquals(parseIncoming(null), null);
  assertEquals(parseIncoming("string inesperada"), null);
});
