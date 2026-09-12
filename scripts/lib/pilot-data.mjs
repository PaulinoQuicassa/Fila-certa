// As 6 instituições piloto e as 12 contas de staff reais, usadas por
// `seed-reference-data.mjs` e `rotate-staff-passwords.mjs` -- extraído
// para aqui para as duas não terem cada uma a sua cópia da mesma lista
// (a duplicação foi exactamente o que permitiu a password antiga
// divergir e ficar espalhada por vários ficheiros).

export const institutions = [
  { id: 'bai', name: 'Banco BAI', branches: [{ id: 'agencia-viana', name: 'Agência Viana', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'banco-exemplo', name: 'Banco Sol', branches: [{ id: 'agencia-maianga', name: 'Agência Maianga', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'bci', name: 'Banco BCI', branches: [{ id: 'agencia-kilamba', name: 'Agência Kilamba', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'bfa', name: 'Banco BFA', branches: [{ id: 'agencia-belas', name: 'Agência Belas', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'bpc', name: 'Banco de Poupança e Crédito (BPC)', branches: [{ id: 'agencia-talatona', name: 'Agência Talatona', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'siac', name: 'SIAC — Serviço Integrado de Atendimento ao Cidadão', branches: [{ id: 'balcao-talatona', name: 'Balcão Talatona', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
];

export const staffList = [
  { email: 'gestor@bai.test', name: 'Rosa Ferreira', role: 'manager', institutionId: 'bai', branchId: 'agencia-viana' },
  { email: 'gestor@bpc.test', name: 'Isabel Ferraz', role: 'manager', institutionId: 'bpc', branchId: 'agencia-talatona' },
  { email: 'gestor@filacerta.test', name: 'Beatriz Neto', role: 'manager', institutionId: 'banco-exemplo', branchId: 'agencia-maianga' },
  { email: 'agente@siac.test', name: 'Kiluanje Mateus', role: 'agent', institutionId: 'siac', branchId: 'balcao-talatona', counterId: 'guiche-1' },
  { email: 'agente@bci.test', name: 'Miguel Sumbo', role: 'agent', institutionId: 'bci', branchId: 'agencia-kilamba', counterId: 'guiche-1' },
  { email: 'agente@bfa.test', name: 'Domingos Neto', role: 'agent', institutionId: 'bfa', branchId: 'agencia-belas', counterId: 'guiche-1' },
  { email: 'gestor@bfa.test', name: 'Ana Kiala', role: 'manager', institutionId: 'bfa', branchId: 'agencia-belas' },
  { email: 'agente@bai.test', name: 'Fernando Bumba', role: 'agent', institutionId: 'bai', branchId: 'agencia-viana', counterId: 'guiche-1' },
  { email: 'gestor@bci.test', name: 'Teresa Vieira', role: 'manager', institutionId: 'bci', branchId: 'agencia-kilamba' },
  { email: 'agente@bpc.test', name: 'Manuel Sacramento', role: 'agent', institutionId: 'bpc', branchId: 'agencia-talatona', counterId: 'guiche-1' },
  { email: 'gestor@siac.test', name: 'Fátima Chissano', role: 'manager', institutionId: 'siac', branchId: 'balcao-talatona' },
  { email: 'agente@filacerta.test', name: 'João Manuel', role: 'agent', institutionId: 'banco-exemplo', branchId: 'agencia-maianga', counterId: 'guiche-3' },
];

// A API Admin do Supabase não filtra por email apesar do parâmetro
// aceitar -- devolve sempre a lista paginada inteira (confirmado a
// testar contra produção: `?email=x` ignorado, tinha de paginar e
// filtrar aqui). Partilhado entre seed e rotação de passwords.
export async function findUserByEmail(authBase, serviceRoleKey, email) {
  let page = 1;
  for (;;) {
    const res = await fetch(`${authBase}/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const users = body.users ?? [];
    const found = users.find((u) => u.email === email);
    if (found) return found;
    if (users.length < 1000) return null;
    page++;
  }
}
