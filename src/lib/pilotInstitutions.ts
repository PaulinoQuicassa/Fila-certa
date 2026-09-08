// Catálogo das instituições reais do piloto -- mesmos IDs/nomes/serviços
// de projectogestaodefilas/lib/data/mock_data.dart, para o painel e a
// estação lerem o serviço certo em vez de terem só o Banco Exemplo
// fixo (ver comentário antigo em PublicDisplay.tsx: "deixa de ser
// hardcoded quando houver mais do que uma agência" -- já há 6).

const bankServices = ['Atendimento Balcão', 'Depósitos e Levantamentos', 'Cartões', 'Crédito Habitação', 'Crédito Pessoal', 'Reclamações'];

const siacServices = [
  'Bilhete de Identidade', 'Registo Civil', 'Trânsito e Matrículas (DTSER)', 'Passaporte e Residência',
  'Cartório Notarial', 'Registo Automóvel', 'Registo Comercial', 'Registo Predial', 'NIF — AGT', 'INSS',
  'Ficheiro Central', 'Licenciamento Comercial (CAEC)', 'Administração Distrital',
];

const pilotServices = ['Abertura de conta', 'Cartão bancário', 'Empréstimo', 'Reclamação'];

export type PilotInstitution = {
  institutionId: string;
  branchId: string;
  name: string;
  services: string[];
};

export const PILOT_INSTITUTIONS: Record<string, PilotInstitution> = {
  'banco-exemplo': { institutionId: 'banco-exemplo', branchId: 'agencia-maianga', name: 'Banco Exemplo · Agência Maianga', services: pilotServices },
  bpc: { institutionId: 'bpc', branchId: 'agencia-talatona', name: 'Banco de Poupança e Crédito (BPC) · Agência Talatona', services: bankServices },
  bfa: { institutionId: 'bfa', branchId: 'agencia-belas', name: 'Banco BFA · Agência Belas', services: bankServices },
  bai: { institutionId: 'bai', branchId: 'agencia-viana', name: 'Banco BAI · Agência Viana', services: bankServices },
  bci: { institutionId: 'bci', branchId: 'agencia-kilamba', name: 'Banco BCI · Agência Kilamba', services: bankServices },
  siac: { institutionId: 'siac', branchId: 'balcao-talatona', name: 'SIAC · Balcão Talatona', services: siacServices },
};

export const DEFAULT_PILOT_ID = 'banco-exemplo';

export function resolvePilotInstitution(institutionId: string | undefined): PilotInstitution {
  return PILOT_INSTITUTIONS[institutionId ?? DEFAULT_PILOT_ID] ?? PILOT_INSTITUTIONS[DEFAULT_PILOT_ID];
}
