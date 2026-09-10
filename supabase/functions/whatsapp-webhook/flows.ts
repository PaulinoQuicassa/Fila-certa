// Máquina de estados da conversa. REGRA: nenhuma função aqui decide
// posição, tempo estimado, ou regras de fila -- só chama RPCs
// existentes (pull_ticket, waiting_ahead_count, branch_wait_stats,
// cancel_ticket) através da sessão do cidadão, e formata a resposta.
import { citizenClient, ensureCitizenSession } from "../_shared/citizenSession.ts";
import { loadState, resetState, saveState, type ConversationContext } from "../_shared/conversationState.ts";
import { logEvent } from "../_shared/messageLog.ts";
import { sendInteractiveButtons, sendInteractiveList, sendText } from "../_shared/meta.ts";

export interface IncomingMessage {
  from: string; // telefone, formato da Meta (sem "+")
  messageId: string;
  profileName?: string;
  replyId?: string; // id do botão/linha escolhida, se interactive
  text?: string; // corpo, se mensagem de texto livre
}

const phoneKey = (from: string) => `+${from}`;

async function sendWelcome(phone: string) {
  await sendInteractiveButtons(
    phone,
    "👋 Bem-vindo ao Fila Certa!\n\nComo podemos ajudar?",
    [
      { id: "WELCOME_JOIN", title: "Entrar na fila" },
      { id: "WELCOME_MY_TICKET", title: "Ver minha senha" },
      { id: "WELCOME_HUMAN", title: "Falar com atendente" },
    ],
  );
}

async function findActiveTicket(citizen: ReturnType<typeof citizenClient>) {
  const { data, error } = await citizen
    .from("tickets")
    .select("id, code, institution_id, branch_id, service, status, counter_id, created_at")
    .in("status", ["waiting", "serving"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function institutionName(citizen: ReturnType<typeof citizenClient>, institutionId: string) {
  const { data } = await citizen.from("institutions").select("name").eq("id", institutionId).maybeSingle();
  return data?.name ?? institutionId;
}

async function showMyTicket(phone: string, citizen: ReturnType<typeof citizenClient>) {
  const ticket = await findActiveTicket(citizen);
  if (!ticket) {
    await sendInteractiveButtons(
      phone,
      "ℹ️ Não encontrámos nenhuma senha activa associada ao seu número.\n\nDeseja entrar numa fila?",
      [{ id: "WELCOME_JOIN", title: "Entrar na fila" }],
    );
    return;
  }

  const instName = await institutionName(citizen, ticket.institution_id);

  if (ticket.status === "serving") {
    await sendText(
      phone,
      `🔔 É a sua vez!\n\n🔢 Senha: ${ticket.code}\n🏢 Instituição: ${instName}\n📋 Serviço: ${ticket.service}\n🔲 Balcão: ${ticket.counter_id ?? "—"}\n\nDirija-se ao balcão indicado.`,
    );
    return;
  }

  const [{ data: ahead }, { data: avgWait }] = await Promise.all([
    citizen.rpc("waiting_ahead_count", { p_ticket_id: ticket.id }),
    citizen.rpc("branch_wait_stats", { p_institution_id: ticket.institution_id, p_branch_id: ticket.branch_id }),
  ]);

  await sendInteractiveButtons(
    phone,
    `🔢 A sua senha: ${ticket.code}\n\n🏢 Instituição: ${instName}\n📋 Serviço: ${ticket.service}\n\n👥 Pessoas à sua frente: ${ahead ?? "—"}\n⏱️ Tempo estimado: ${avgWait != null ? `${avgWait} min` : "—"}\n\nEstado: Em espera`,
    [
      { id: "MYTICKET_REFRESH", title: "Actualizar" },
      { id: `CANCEL_TICKET_${ticket.id}`, title: "Cancelar senha" },
    ],
  );
}

async function showInstitutions(phone: string, citizen: ReturnType<typeof citizenClient>) {
  // Só instituições com pelo menos uma filial E um serviço configurado
  // -- evita mostrar instituições de teste/incompletas (ex.: criadas
  // na consola do dono só para experimentar) a um cidadão real.
  const { data: institutions, error } = await citizen
    .from("institutions")
    .select("id, name, branches!inner(id), services!inner(id)")
    .order("name");
  if (error) throw error;

  const seen = new Set<string>();
  const rows = (institutions ?? [])
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .slice(0, 10)
    .map((i) => ({ id: `INST_${i.id}`, title: i.name.slice(0, 24) }));

  if (rows.length === 0) {
    await sendText(phone, "De momento não há nenhuma instituição disponível. Tente novamente mais tarde.");
    return;
  }

  await sendInteractiveList(phone, "Escolha a instituição:", "Ver instituições", [{ title: "Instituições", rows }]);
}

async function showBranchesOrServices(
  phone: string,
  citizen: ReturnType<typeof citizenClient>,
  institutionId: string,
  institutionName: string,
) {
  const { data: branches, error } = await citizen.from("branches").select("id, name").eq("institution_id", institutionId).order("name");
  if (error) throw error;

  if ((branches ?? []).length <= 1) {
    const branchId = branches?.[0]?.id;
    if (!branchId) {
      await sendText(phone, "Esta instituição ainda não tem filiais configuradas.");
      await resetState(phone);
      return;
    }
    await showServices(phone, citizen, institutionId, institutionName, branchId);
    return;
  }

  const rows = branches!.slice(0, 10).map((b) => ({ id: `BRANCH_${b.id}`, title: b.name.slice(0, 24) }));
  await saveState(phone, "SELECT_BRANCH", { institutionId, institutionName });
  await sendInteractiveList(phone, "Escolha a filial:", "Ver filiais", [{ title: "Filiais", rows }]);
}

async function showServices(
  phone: string,
  citizen: ReturnType<typeof citizenClient>,
  institutionId: string,
  institutionName: string,
  branchId: string,
) {
  const { data: services, error } = await citizen.from("services").select("name").eq("institution_id", institutionId).order("name");
  if (error) throw error;

  const rows = (services ?? []).slice(0, 10).map((s) => ({ id: `SERVICE_${s.name}`, title: s.name.slice(0, 24) }));
  if (rows.length === 0) {
    await sendText(phone, "Esta instituição ainda não tem serviços configurados.");
    await resetState(phone);
    return;
  }

  await saveState(phone, "SELECT_SERVICE", { institutionId, institutionName, branchId });
  await sendInteractiveList(phone, "Escolha o serviço:", "Ver serviços", [{ title: "Serviços", rows }]);
}

async function confirmQueue(phone: string, ctx: ConversationContext) {
  await sendInteractiveButtons(
    phone,
    `Confirma a entrada na fila?\n\n🏢 Instituição: ${ctx.institutionName ?? ctx.institutionId}\n📋 Serviço: ${ctx.service}`,
    [
      { id: "QUEUE_CONFIRM", title: "Confirmar" },
      { id: "QUEUE_CANCEL", title: "Cancelar" },
    ],
  );
}

async function joinQueue(phone: string, citizen: ReturnType<typeof citizenClient>, ctx: ConversationContext) {
  if (!ctx.institutionId || !ctx.branchId || !ctx.service) {
    await sendText(phone, "Ocorreu um problema a confirmar os dados. Vamos começar de novo.");
    await resetState(phone);
    await sendWelcome(phone);
    return;
  }

  const { data: ticket, error } = await citizen.rpc("pull_ticket", {
    p_institution_id: ctx.institutionId,
    p_branch_id: ctx.branchId,
    p_service: ctx.service,
    p_channel: "whatsapp",
  });

  if (error) {
    await sendText(phone, `⚠️ Não foi possível entrar na fila: ${error.message}`);
    await resetState(phone);
    return;
  }

  const [{ data: ahead }, { data: avgWait }] = await Promise.all([
    citizen.rpc("waiting_ahead_count", { p_ticket_id: ticket.id }),
    citizen.rpc("branch_wait_stats", { p_institution_id: ctx.institutionId, p_branch_id: ctx.branchId }),
  ]);
  const instName = await institutionName(citizen, ctx.institutionId);

  await sendText(
    phone,
    `✅ Entrada confirmada!\n\n🔢 Senha: ${ticket.code}\n🏢 Instituição: ${instName}\n📋 Serviço: ${ctx.service}\n\n👥 Posição actual: ${(ahead ?? 0) + 1}.º\n⏱️ Tempo estimado: ${avgWait != null ? `${avgWait} min` : "—"}\n\nPode acompanhar a sua senha através deste WhatsApp.`,
  );
  await logEvent(phone, "queue_joined", ticket.id);
  await resetState(phone);
}

async function askCancelConfirmation(phone: string, ticketId: string) {
  await saveState(phone, "AWAIT_CANCEL_CONFIRM", { ticketId });
  await sendInteractiveButtons(
    phone,
    `⚠️ Tem a certeza que deseja cancelar a senha?\n\nAo confirmar, a sua posição será libertada.`,
    [
      { id: "CANCEL_CONFIRM", title: "Sim, cancelar" },
      { id: "CANCEL_ABORT", title: "Não" },
    ],
  );
}

async function performCancel(phone: string, citizen: ReturnType<typeof citizenClient>, ticketId: string) {
  const { error } = await citizen.rpc("cancel_ticket", { p_ticket_id: ticketId });
  if (error) {
    await sendText(phone, `⚠️ Não foi possível cancelar: ${error.message}`);
  } else {
    await sendText(phone, "A sua senha foi cancelada.");
    await logEvent(phone, "queue_cancelled", ticketId);
  }
  await resetState(phone);
}

/** Ponto de entrada único, chamado pelo webhook para cada mensagem
 * inbound já deduplicada. */
export async function handleIncomingMessage(msg: IncomingMessage) {
  const phone = phoneKey(msg.from);
  const session = await ensureCitizenSession(phone, msg.profileName);
  const citizen = citizenClient(session.accessToken);
  const { state, context } = await loadState(phone);

  const reply = msg.replyId;

  // Acções disponíveis em qualquer estado (atalhos, não dependem do
  // fluxo actual estar "certo").
  if (reply === "WELCOME_JOIN") {
    await saveState(phone, "SELECT_INSTITUTION", {});
    await showInstitutions(phone, citizen);
    return;
  }
  if (reply === "WELCOME_MY_TICKET" || reply === "MYTICKET_REFRESH") {
    await showMyTicket(phone, citizen);
    return;
  }
  if (reply === "WELCOME_HUMAN") {
    await sendText(
      phone,
      "☎️ Para falar com um atendente humano, contacte directamente a instituição pretendida. Pode consultar o contacto na app ou site do Fila Certa.",
    );
    await logEvent(phone, "human_handoff_requested");
    return;
  }
  if (reply?.startsWith("CANCEL_TICKET_")) {
    await askCancelConfirmation(phone, reply.replace("CANCEL_TICKET_", ""));
    return;
  }

  switch (state) {
    case "SELECT_INSTITUTION": {
      if (reply?.startsWith("INST_")) {
        const institutionId = reply.replace("INST_", "");
        const name = await institutionName(citizen, institutionId);
        await showBranchesOrServices(phone, citizen, institutionId, name);
        return;
      }
      await showInstitutions(phone, citizen);
      return;
    }
    case "SELECT_BRANCH": {
      if (reply?.startsWith("BRANCH_") && context.institutionId) {
        await showServices(phone, citizen, context.institutionId, context.institutionName ?? context.institutionId, reply.replace("BRANCH_", ""));
        return;
      }
      await sendText(phone, "Por favor escolha uma filial da lista.");
      return;
    }
    case "SELECT_SERVICE": {
      if (reply?.startsWith("SERVICE_") && context.institutionId && context.branchId) {
        const service = reply.replace("SERVICE_", "");
        const ctx = { ...context, service };
        await saveState(phone, "CONFIRM_QUEUE", ctx);
        await confirmQueue(phone, ctx);
        return;
      }
      await sendText(phone, "Por favor escolha uma opção da lista.");
      return;
    }
    case "CONFIRM_QUEUE": {
      if (reply === "QUEUE_CONFIRM") {
        await joinQueue(phone, citizen, context);
        return;
      }
      if (reply === "QUEUE_CANCEL") {
        await resetState(phone);
        await sendWelcome(phone);
        return;
      }
      await confirmQueue(phone, context);
      return;
    }
    case "AWAIT_CANCEL_CONFIRM": {
      if (reply === "CANCEL_CONFIRM" && context.ticketId) {
        await performCancel(phone, citizen, context.ticketId);
        return;
      }
      if (reply === "CANCEL_ABORT") {
        await resetState(phone);
        await showMyTicket(phone, citizen);
        return;
      }
      await sendText(phone, "Por favor confirme ou cancele usando os botões.");
      return;
    }
    default: {
      await sendWelcome(phone);
    }
  }
}
