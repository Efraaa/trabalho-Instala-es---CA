/* ==========================================================================
   Ferramenta para auxílio no dimensionamento de instalações elétricas
   --------------------------------------------------------------------------
   Uso acadêmico/educacional. Não substitui projeto elétrico elaborado e
   verificado por profissional habilitado, nem a consulta direta à edição
   vigente da ABNT NBR 5410 (edição de referência considerada neste projeto:
   ABNT NBR 5410:2004, Versão Corrigida:2008 — conforme consulta ao catálogo
   oficial da ABNT. O PDF de 1997 eventualmente anexado ao projeto NÃO é
   tratado como a edição vigente).

   Organização do arquivo (módulos lógicos, em JavaScript simples):
     1. Estado global
     2. Utilitários
     3. Tabelas de referência configuráveis (NÃO são a tabela oficial da NBR)
     4. Validação de entradas
     5. Cálculos de cômodo / área / perímetro / iluminação
     6. Cálculo de TUG (tomadas de uso geral)
     7. Circuitos: montagem, tensão e corrente (mono/bi/trifásico)
     8. Fatores de correção e capacidade de condução
     9. Demanda
    10. Queda de tensão
    11. Disjuntor (coordenação Ib/Iz/In)
    12. PE e Neutro
    13. Eletroduto
    14. Balanceamento de fases
    15. DR e DPS (verificações)
    16. Diagrama unifilar (SVG)
    17. Renderização da interface (uma seção por etapa)
    18. Relatório / memorial de cálculo
    19. Persistência (JSON / localStorage) — camada isolada, substituível
        futuramente por API/banco de dados
    20. Inicialização e eventos
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. ESTADO GLOBAL
   -------------------------------------------------------------------------- */
var S = {
	step: 1,
	installation: {
		tipo: "residencial",
		sistema: "mono", // 'mono' | 'bi' | 'tri'
		vf: 127, // tensão fase-neutro (V)
		vff: 220, // tensão entre fases (V)
		freq: 60,
		material: "Cu", // 'Cu' | 'Al'
		isolacao: "PVC70", // 'PVC70' | 'XLPE90'
		metodo: "B1", // método de instalação (ver METHODS)
		temp: 30, // temperatura ambiente (°C)
		agrupamento: 1, // nº de circuitos agrupados no mesmo agrupamento
		quedaLimite: 4, // limite de queda de tensão adotado (%)
		distAlim: 10, // distância do ponto de entrega até o QDC (m)
		expansao: 20, // reserva para expansão futura (%)
		ocupacaoEletroduto: 40, // taxa de ocupação máxima adotada (%) — configurável
	},
	rooms: [],
	loads: [],
	circuits: [],
	faseOverride: {}, // { circuitId: 'A-N' } — travas manuais de balanceamento
};

/* --------------------------------------------------------------------------
   2. UTILITÁRIOS
   -------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const N = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};
const fmt = (v, d = 2) =>
	Number(v || 0)
		.toFixed(d)
		.replace(".", ",");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (v) =>
	String(v ?? "").replace(
		/[&<>"']/g,
		(m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m],
	);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* --------------------------------------------------------------------------
   3. TABELAS DE REFERÊNCIA CONFIGURÁVEIS
   --------------------------------------------------------------------------
   IMPORTANTE: os valores abaixo são dados de referência internos do
   protótipo, usados apenas para que a ferramenta seja funcional em caráter
   acadêmico. Eles NÃO são uma reprodução das tabelas da ABNT NBR 5410 e
   NÃO devem ser usados como valor normativo definitivo. Antes de qualquer
   uso além do educacional, os valores desta seção devem ser confirmados
   e, se necessário, substituídos conforme a edição normativa adotada.
   Esse aviso é repetido na interface e no relatório.
   -------------------------------------------------------------------------- */
const REFERENCE_NOTICE =
	"Dados de referência configuráveis — confirmar conforme edição normativa adotada. Não reproduzem tabela oficial da ABNT NBR 5410.";

const SECTIONS = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120];

// Capacidade de condução base (A), condutor de cobre, isolação PVC 70°C,
// método de referência B1 (eletroduto embutido em alvenaria), 30°C,
// sem agrupamento — ponto de partida configurável do protótipo.
const AMP_BASE = {
	1.5: 15.5,
	2.5: 21,
	4: 28,
	6: 36,
	10: 50,
	16: 68,
	25: 89,
	35: 110,
	50: 134,
	70: 171,
	95: 207,
	120: 239,
};

// Métodos de instalação — classificação simplificada e didática do
// protótipo (não é uma transcrição literal da tabela de métodos da NBR
// 5410). Cada método aplica um multiplicador sobre a capacidade base.
const METHODS = {
	B1: { label: "Eletroduto embutido em alvenaria/laje", factor: 1.0 },
	B2: { label: "Eletroduto aparente (sobre parede)", factor: 1.06 },
	C: { label: "Diretamente sobre a parede / calha aberta", factor: 1.14 },
	D: { label: "Enterrado (eletroduto ou diretamente no solo)", factor: 0.86 },
};

// Multiplicadores de material e isolação sobre a base Cu/PVC70/B1.
const MATERIAL_FACTOR = { Cu: 1.0, Al: 0.78 };
const ISOLATION_FACTOR = { PVC70: 1.0, XLPE90: 1.11 };
const ISOLATION_LABEL = { PVC70: "PVC 70 °C", XLPE90: "XLPE/EPR 90 °C" };

// K1 — fator de correção de temperatura (referência do protótipo por
// isolação; interpola dentro da faixa configurada).
const K1_TABLE = {
	PVC70: { 20: 1.08, 25: 1.04, 30: 1.0, 35: 0.96, 40: 0.91, 45: 0.87, 50: 0.82, 55: 0.76, 60: 0.71 },
	XLPE90: {
		20: 1.06,
		25: 1.03,
		30: 1.0,
		35: 0.97,
		40: 0.94,
		45: 0.9,
		50: 0.87,
		55: 0.83,
		60: 0.79,
		65: 0.74,
		70: 0.7,
	},
};

// K2 — fator de correção de agrupamento (referência do protótipo, por
// número de circuitos agrupados em um mesmo eletroduto/bandeja).
const K2_TABLE = { 1: 1.0, 2: 0.8, 3: 0.7, 4: 0.65, 5: 0.6, 6: 0.57, 7: 0.54, 8: 0.52, 9: 0.5 };
function k2For(n) {
	if (n <= 1) return 1;
	if (K2_TABLE[n] !== undefined) return K2_TABLE[n];
	return n >= 9 ? 0.45 : K2_TABLE[9];
}

// PE — critério de redução de seção comumente adotado como ponto de
// partida (Sf ≤ 16 → Spe = Sf; 16 < Sf ≤ 35 → Spe = 16; Sf > 35 → Spe = Sf/2).
// Confirmar conforme a tabela da edição normativa adotada.
function peFor(sf) {
	if (sf <= 16) return sf;
	if (sf <= 35) return 16;
	return sf / 2;
}

const BREAKERS = [6, 10, 16, 20, 25, 32, 40, 50, 63, 70, 80, 100];
var CONDUIT_SIZES = [16, 20, 25, 32, 40, 50, 60, 75, 85, 110]; // mm, referência comercial

// Diâmetro externo aproximado (mm) do condutor isolado, por seção —
// aproximação do protótipo usada apenas para estimar a taxa de ocupação
// do eletroduto; confirmar com dados de fabricante/norma antes de uso real.
const COND_DIAM = {
	1.5: 3.0,
	2.5: 3.4,
	4: 3.9,
	6: 4.4,
	10: 5.6,
	16: 6.6,
	25: 8.2,
	35: 9.4,
	50: 11.5,
	70: 13.2,
	95: 15.6,
	120: 17.4,
};

const TYPES = [
	"Chuveiro",
	"Forno elétrico",
	"Máquina de lavar",
	"Ar-condicionado",
	"Torneira elétrica",
	"Bomba",
	"Cooktop",
	"Micro-ondas",
	"Lava-louças",
	"Outro",
];
const ROOM_TYPES = [
	"Quarto",
	"Sala",
	"Cozinha",
	"Banheiro",
	"Área de serviço",
	"Corredor",
	"Varanda",
	"Garagem",
	"Outro",
];
const WET_ROOMS = ["Banheiro", "Cozinha", "Área de serviço", "Varanda", "Garagem"];

// Fatores de demanda — o protótipo NÃO adota uma tabela normativa de
// fatores de demanda por não haver confirmação segura das fontes
// disponíveis. O valor default é 1 (potência de demanda = potência
// instalada) e pode ser alterado manualmente pelo usuário por grupo de
// carga; quando alterado, isso fica registrado como "adotado manualmente".
const DEMAND_DEFAULT = { iluminacao: 1, tug: 1, tue: 1 };

/* --------------------------------------------------------------------------
   4. VALIDAÇÃO DE ENTRADAS
   -------------------------------------------------------------------------- */
function validateAll() {
	const errs = [];
	const ins = S.installation;
	if (!(ins.vf > 0)) errs.push("Tensão fase-neutro deve ser maior que zero.");
	if (!(ins.vff > 0)) errs.push("Tensão entre fases deve ser maior que zero.");
	if (!(ins.freq > 0)) errs.push("Frequência inválida.");
	if (ins.temp < -10 || ins.temp > 90) errs.push("Temperatura ambiente fora de faixa plausível.");
	if (ins.distAlim < 0) errs.push("Distância do alimentador não pode ser negativa.");
	if (ins.quedaLimite <= 0) errs.push("Limite de queda de tensão deve ser maior que zero.");
	if (ins.agrupamento < 1) errs.push("Número de circuitos agrupados deve ser pelo menos 1.");

	S.rooms.forEach((r) => {
		if (!r.name || !r.name.trim()) errs.push("Há um cômodo sem nome.");
		if (r.l <= 0 || r.w <= 0)
			errs.push(`Cômodo "${r.name || "(sem nome)"}": comprimento e largura devem ser maiores que zero.`);
	});

	S.loads.forEach((l) => {
		if (!l.room) errs.push(`Equipamento "${l.name || l.type}" está sem cômodo associado.`);
		if (l.p <= 0) errs.push(`Equipamento "${l.name || l.type}": potência deve ser maior que zero.`);
		if (l.v <= 0) errs.push(`Equipamento "${l.name || l.type}": tensão deve ser maior que zero.`);
		if (l.fp <= 0 || l.fp > 1)
			errs.push(`Equipamento "${l.name || l.type}": fator de potência deve estar entre 0 (exclusive) e 1.`);
		if (l.q < 1) errs.push(`Equipamento "${l.name || l.type}": quantidade deve ser pelo menos 1.`);
		if (l.d < 0) errs.push(`Equipamento "${l.name || l.type}": distância não pode ser negativa.`);
	});

	S.circuits.forEach((c) => {
		if (!(tensaoCircuito(c) > 0)) errs.push(`Circuito "${c.name}": tensão do circuito inválida.`);
		if (c.p < 0) errs.push(`Circuito "${c.name}": potência não pode ser negativa.`);
		if (c.d < 0) errs.push(`Circuito "${c.name}": distância não pode ser negativa.`);
		if (S.installation.sistema === "mono" && c.phase !== "A-N")
			errs.push(`Circuito "${c.name}": sistema monofásico só admite A-N.`);
	});

	return errs;
}
function renderAlerts() {
	const errs = validateAll();
	$("alert").innerHTML = errs.length
		? `<div class="warn-box"><b>Verificar antes de prosseguir (${errs.length}):</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
		: "";
}

/* --------------------------------------------------------------------------
   5. CÔMODO / ÁREA / PERÍMETRO / ILUMINAÇÃO
   -------------------------------------------------------------------------- */
function calcularArea(r) {
	return N(r.l) * N(r.w);
}
function calcularPerimetro(r) {
	return 2 * (N(r.l) + N(r.w));
}
// Critério de área para iluminação: 100 VA até 6 m², mais 60 VA para cada
// 4 m² inteiros excedentes. Critério utilizado como referência de projeto
// pela versão original desta ferramenta; deve ser confirmado pelo usuário
// junto à edição normativa adotada — não é apresentado como valor absoluto.
function calcularIluminacao(area) {
	if (area <= 6) return 100;
	return 100 + Math.floor((area - 6) / 4) * 60;
}

/* --------------------------------------------------------------------------
   6. TUG — TOMADAS DE USO GERAL
   -------------------------------------------------------------------------- */
// Sugestão heurística de quantidade mínima de TUG por cômodo, baseada no
// perímetro e no tipo de ambiente. É uma heurística do protótipo — não é
// a regra oficial de tomada por metro de perímetro da norma — sempre
// editável e sempre exibida separadamente da quantidade adotada.
function calcularTUGMinimo(r) {
	const p = calcularPerimetro(r);
	if (r.type === "Banheiro") return 1;
	if (["Cozinha", "Área de serviço"].includes(r.type)) return Math.max(3, Math.ceil(p / 3.5));
	if (r.type === "Sala" || r.type === "Quarto") return Math.max(1, Math.ceil(p / 5));
	return Math.max(1, Math.ceil(p / 5));
}

/* --------------------------------------------------------------------------
   7. CIRCUITOS: TENSÃO E CORRENTE (MONO / BI / TRIFÁSICO)
   --------------------------------------------------------------------------
   c.phase pode ser: 'A-N','B-N','C-N' (fase-neutro), 'A-B','A-C','B-C'
   (fase-fase) ou 'A-B-C' (trifásico balanceado, três fases).
   -------------------------------------------------------------------------- */
function opcoesFasePara(tensaoTipo) {
	const sis = S.installation.sistema;
	if (sis === "mono") return ["A-N"];
	if (sis === "bi") return tensaoTipo === "ff" ? ["A-B"] : ["A-N", "B-N"];
	// trifásico
	if (tensaoTipo === "3f") return ["A-B-C"];
	if (tensaoTipo === "ff") return ["A-B", "A-C", "B-C"];
	return ["A-N", "B-N", "C-N"];
}
function fasesEnvolvidas(opt) {
	return opt.split("-").filter((x) => x !== "N");
}
function precisaNeutro(opt) {
	return opt.includes("N");
}

// Classifica o tipo de tensão de uma carga (TUE) comparando com vf/vff
// cadastrados na instalação — NÃO assume que todo sistema bifásico é
// necessariamente 127/220 V; usa sempre os valores informados pelo usuário.
function tensaoTipoDaCarga(v) {
	const ins = S.installation;
	if (Math.abs(v - ins.vff) <= Math.abs(v - ins.vf)) return ins.sistema === "tri" ? "ff" : "ff";
	return "fn";
}

function tensaoCircuito(c) {
	const ins = S.installation;
	if (c.phase === "A-B-C") return ins.vff;
	return precisaNeutro(c.phase) ? ins.vf : ins.vff;
}

// I = P/(V·fp) para fase-neutro e fase-fase; I = P/(√3·Vff·fp) para
// trifásico balanceado (A-B-C). As hipóteses assumidas são: carga
// equilibrada entre as três fases e fator de potência único informado.
function calcularCorrente(c) {
	const fp = clamp(N(c.fp) || 1, 0.01, 1);
	if (c.phase === "A-B-C") {
		const vff = S.installation.vff;
		return vff > 0 ? c.p / (Math.sqrt(3) * vff * fp) : 0;
	}
	const v = tensaoCircuito(c);
	return v > 0 ? c.p / (v * fp) : 0;
}

/* --------------------------------------------------------------------------
   8. FATORES DE CORREÇÃO E CAPACIDADE DE CONDUÇÃO
   -------------------------------------------------------------------------- */
function fatorK1() {
	const tab = K1_TABLE[S.installation.isolacao] || K1_TABLE.PVC70;
	const temps = Object.keys(tab)
		.map(Number)
		.sort((a, b) => a - b);
	const t = clamp(S.installation.temp, temps[0], temps[temps.length - 1]);
	// interpolação linear entre os pontos configurados
	for (let i = 0; i < temps.length - 1; i++) {
		if (t >= temps[i] && t <= temps[i + 1]) {
			const t0 = temps[i],
				t1 = temps[i + 1],
				v0 = tab[t0],
				v1 = tab[t1];
			return t1 === t0 ? v0 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
		}
	}
	return tab[temps[temps.length - 1]];
}
function fatorK2() {
	return k2For(Math.max(1, Math.round(N(S.installation.agrupamento) || 1)));
}

// Capacidade de condução corrigida (Iz), a partir da estrutura de dados
// centralizada (seção, material, isolação, método de instalação, K1, K2).
function capacidadeBase(secao) {
	const ins = S.installation;
	const base = AMP_BASE[secao];
	if (base === undefined) return 0;
	const metodo = METHODS[ins.metodo] || METHODS.B1;
	return base * metodo.factor * (MATERIAL_FACTOR[ins.material] ?? 1) * (ISOLATION_FACTOR[ins.isolacao] ?? 1);
}
function capacidadeCorrigida(secao, k1, k2) {
	return capacidadeBase(secao) * k1 * k2;
}

function escolherSecao(Ib, min, k1, k2) {
	for (const s of SECTIONS) {
		if (s < min) continue;
		if (capacidadeCorrigida(s, k1, k2) >= Ib) return s;
	}
	return SECTIONS[SECTIONS.length - 1];
}

/* --------------------------------------------------------------------------
   9. DEMANDA
   -------------------------------------------------------------------------- */
function grupoDemanda(c) {
	return c.type === "Iluminação" ? "iluminacao" : c.type === "TUG" ? "tug" : "tue";
}
function fatorDemanda(c) {
	const manual = S.installation.fatorDemandaManual && S.installation.fatorDemandaManual[grupoDemanda(c)];
	if (manual !== undefined && manual !== null && manual !== "") return { valor: N(manual), manual: true };
	return { valor: DEMAND_DEFAULT[grupoDemanda(c)] ?? 1, manual: false };
}
function calcularDemanda(c) {
	const fd = fatorDemanda(c);
	return { potenciaInstalada: c.p, fator: fd.valor, manual: fd.manual, potenciaDemanda: c.p * fd.valor };
}

/* --------------------------------------------------------------------------
   10. QUEDA DE TENSÃO
   --------------------------------------------------------------------------
   Monofásico / fase-fase (circuito de 2 condutores, ida e volta):
     ΔV = 2 · ρ · L · Ib · cos φ / S
   Trifásico balanceado (A-B-C, 3 condutores):
     ΔV = √3 · ρ · L · Ib · cos φ / S
   -------------------------------------------------------------------------- */
function calcularQuedaTensao(c, secao, Ib) {
	const ins = S.installation;
	const rho = ins.material === "Cu" ? 0.0175 : 0.0282; // Ω·mm²/m — resistividade de referência a 20°C
	const fp = clamp(N(c.fp) || 1, 0.01, 1);
	const trifasico = c.phase === "A-B-C";
	const k = trifasico ? Math.sqrt(3) : 2;
	const dropV = secao > 0 ? (k * rho * N(c.d) * Ib * fp) / secao : 0;
	const vref = tensaoCircuito(c);
	const dropPct = vref > 0 ? (dropV / vref) * 100 : 0;
	const limite = N(ins.quedaLimite);
	return {
		formula: trifasico ? "√3·ρ·L·Ib·cosφ/S" : "2·ρ·L·Ib·cosφ/S",
		dropV,
		dropPct,
		limite,
		atende: dropPct <= limite,
	};
}

/* --------------------------------------------------------------------------
   11. DISJUNTOR — COORDENAÇÃO Ib / Iz / In
   -------------------------------------------------------------------------- */
function dimensionarDisjuntor(Ib, Iz) {
	const In = BREAKERS.find((b) => b >= Ib && b <= Iz) ?? null;
	const coordenado = In !== null;
	const status = Ib > Iz ? "NÃO ATENDE" : coordenado ? "ATENDE" : "NECESSITA VERIFICAÇÃO";
	return { Ib, Iz, In, coordenado, status };
}

/* --------------------------------------------------------------------------
   12. PE E NEUTRO
   -------------------------------------------------------------------------- */
function dimensionarPE(secaoFase) {
	const spe = peFor(secaoFase);
	return {
		secaoFase,
		secaoPE: spe,
		criterio:
			"Redução por faixa de seção da fase (Sf≤16→Spe=Sf; 16<Sf≤35→Spe=16; Sf>35→Spe=Sf/2) — " + REFERENCE_NOTICE,
	};
}
function dimensionarNeutro(c, secaoFase) {
	if (!precisaNeutro(c.phase)) {
		return {
			aplicavel: false,
			secaoNeutro: null,
			status: "NÃO APLICÁVEL",
			observacao: "Circuito entre fases, sem condutor neutro.",
		};
	}
	if (c.phase === "A-B-C") {
		return {
			aplicavel: true,
			secaoNeutro: secaoFase,
			status: "NECESSITA VERIFICAÇÃO",
			observacao:
				"Dimensionamento do neutro requer verificação complementar (equilíbrio de fases, presença de harmônicas e cargas monofásicas conectadas ao circuito trifásico).",
		};
	}
	// circuito fase-neutro monofásico: adota-se, como ponto de partida,
	// neutro de mesma seção da fase.
	return {
		aplicavel: true,
		secaoNeutro: secaoFase,
		status: "NECESSITA VERIFICAÇÃO",
		observacao:
			"Seção do neutro adotada igual à seção da fase como ponto de partida; confirmar conforme critério da edição normativa adotada.",
	};
}

/* --------------------------------------------------------------------------
   13. ELETRODUTO
   -------------------------------------------------------------------------- */
function dimensionarEletroduto(c, secaoFase, secaoPE) {
	const fases = fasesEnvolvidas(c.phase).length;
	const neutro = precisaNeutro(c.phase) ? 1 : 0;
	const qtdCondutores = fases + neutro + 1; // + PE
	const dCond = COND_DIAM[secaoFase] ?? COND_DIAM[SECTIONS[SECTIONS.length - 1]];
	const dPE = COND_DIAM[secaoPE] ?? dCond;
	const areaCondutor = Math.PI * Math.pow(dCond / 2, 2);
	const areaPE = Math.PI * Math.pow(dPE / 2, 2);
	const areaTotal = areaCondutor * (fases + neutro) + areaPE;
	const ocupacao = clamp(N(S.installation.ocupacaoEletroduto) || 40, 5, 60) / 100;
	const areaMinimaEletroduto = areaTotal / ocupacao;
	const diametroMinimo = 2 * Math.sqrt(areaMinimaEletroduto / Math.PI);
	const comercial = CONDUIT_SIZES.find((d) => d >= diametroMinimo);
	if (!Number.isFinite(diametroMinimo) || diametroMinimo <= 0) {
		return {
			status: "NECESSITA VERIFICAÇÃO",
			observacao: "Não foi possível realizar o dimensionamento completo do eletroduto.",
		};
	}
	return {
		qtdCondutores,
		areaCondutor,
		areaPE,
		areaTotal,
		ocupacao: ocupacao * 100,
		diametroMinimo,
		comercial: comercial ?? CONDUIT_SIZES[CONDUIT_SIZES.length - 1],
		status: comercial ? "ATENDE" : "NECESSITA VERIFICAÇÃO",
	};
}

/* --------------------------------------------------------------------------
   14. BALANCEAMENTO DE FASES
   --------------------------------------------------------------------------
   Heurística gulosa: para cada circuito (do maior para o menor, em VA),
   escolhe — entre as opções de fase compatíveis com o tipo de tensão da
   carga — aquela que resulta na menor diferença entre a fase mais e a
   menos carregada, considerando o que já foi alocado. Circuitos travados
   manualmente (S.faseOverride) mantêm a fase escolhida pelo usuário.
   -------------------------------------------------------------------------- */
function calcularBalanceamento() {
	const totals = { A: 0, B: 0, C: 0 };
	const ordenado = [...S.circuits].sort((a, b) => b.p - a.p);
	const assign = {};
	ordenado.forEach((c) => {
		const opts = opcoesFasePara(c.tensaoTipo || "fn");
		let escolhida = S.faseOverride[c.id] && opts.includes(S.faseOverride[c.id]) ? S.faseOverride[c.id] : null;
		if (!escolhida) {
			let melhor = opts[0],
				melhorScore = Infinity;
			opts.forEach((opt) => {
				const tocadas = fasesEnvolvidas(opt);
				const parcela = c.p / tocadas.length;
				const proj = { ...totals };
				tocadas.forEach((f) => (proj[f] += parcela));
				const vals = ["A", "B", "C"].map((f) => proj[f]);
				const score = Math.max(...vals) - Math.min(...vals);
				if (score < melhorScore) {
					melhorScore = score;
					melhor = opt;
				}
			});
			escolhida = melhor;
		}
		const tocadas = fasesEnvolvidas(escolhida);
		const parcela = c.p / tocadas.length;
		tocadas.forEach((f) => (totals[f] += parcela));
		assign[c.id] = escolhida;
	});
	const vals = ["A", "B", "C"].map((f) => totals[f]);
	const max = Math.max(...vals),
		min = Math.min(...vals);
	const imbalance = max > 0 ? ((max - min) / max) * 100 : 0;
	return { assign, totals, imbalance };
}

/* --------------------------------------------------------------------------
   15. DR E DPS (VERIFICAÇÕES)
   -------------------------------------------------------------------------- */
function verificarDR(c, roomType) {
	const areaMolhada = roomType && WET_ROOMS.includes(roomType);
	if (c.type === "TUE" && roomType === "Banheiro") {
		return {
			status: "NECESSITA VERIFICAÇÃO",
			observacao:
				"Circuito de equipamento em banheiro: tipicamente objeto de proteção diferencial (DR). Confirmar conforme esquema de aterramento e critérios aplicáveis.",
		};
	}
	if (areaMolhada || c.type === "TUG") {
		return {
			status: "NECESSITA VERIFICAÇÃO",
			observacao:
				"Circuito de tomada em área que pode envolver umidade/contato com pessoas: avaliar necessidade de proteção diferencial (DR). Não há seleção automática universal.",
		};
	}
	return {
		status: "NECESSITA VERIFICAÇÃO",
		observacao: "Avaliar necessidade de DR conforme a função do circuito e as condições reais de instalação.",
	};
}
function verificarDPS() {
	return {
		status: "NECESSITA VERIFICAÇÃO",
		observacao:
			"Verificar necessidade e especificação de DPS conforme as características da instalação e critérios normativos aplicáveis. O software não realiza seleção normativa completa.",
	};
}

/* --------------------------------------------------------------------------
   CÁLCULO CONSOLIDADO DE UM CIRCUITO (usa os módulos 7 a 15)
   -------------------------------------------------------------------------- */
function calc(c) {
	const Ib = calcularCorrente(c);
	const k1 = fatorK1(),
		k2 = fatorK2();
	const minSecao = c.type === "Iluminação" ? 1.5 : 2.5;
	const secao = escolherSecao(Ib, minSecao, k1, k2);
	const IzBase = capacidadeBase(secao);
	const Iz = capacidadeCorrigida(secao, k1, k2);
	const queda = calcularQuedaTensao(c, secao, Ib);
	const disjuntor = dimensionarDisjuntor(Ib, Iz);
	const pe = dimensionarPE(secao);
	const neutro = dimensionarNeutro(c, secao);
	const eletroduto = dimensionarEletroduto(c, secao, pe.secaoPE);
	const demanda = calcularDemanda(c);
	const room = c.roomRef ? roomById(c.roomRef) : c.type !== "TUE" ? null : null;
	const dr = verificarDR(c, room ? room.type : null);
	let status = "ATENDE";
	if (disjuntor.status === "NÃO ATENDE" || !queda.atende) status = "NÃO ATENDE";
	else if (disjuntor.status === "NECESSITA VERIFICAÇÃO") status = "NECESSITA VERIFICAÇÃO";
	return {
		Ib,
		V: tensaoCircuito(c),
		k1,
		k2,
		secao,
		IzBase,
		Iz,
		queda,
		disjuntor,
		pe,
		neutro,
		eletroduto,
		demanda,
		dr,
		status,
	};
}
function roomById(id) {
	return S.rooms.find((r) => r.id === id);
}

/* --------------------------------------------------------------------------
   16. DIAGRAMA UNIFILAR (SVG)
   -------------------------------------------------------------------------- */
function diagramaSVG() {
	const w = 760,
		rowH = 34,
		top = 60,
		left = 210;
	const h = top + Math.max(1, S.circuits.length) * rowH + 30;
	let rows = "";
	S.circuits.forEach((c, i) => {
		const x = c.calc || calc(c);
		const y = top + i * rowH;
		const cor = x.status === "ATENDE" ? "#16a34a" : x.status === "NÃO ATENDE" ? "#dc2626" : "#d97706";
		rows += `<line x1="${left - 30}" y1="${top - 10}" x2="${left - 30}" y2="${y}" stroke="#94a3b8" stroke-width="2"/>`;
		rows += `<line x1="${left - 30}" y1="${y}" x2="${left}" y2="${y}" stroke="#94a3b8" stroke-width="2"/>`;
		rows += `<circle cx="${left}" cy="${y}" r="4" fill="${cor}"/>`;
		rows += `<text x="${left + 12}" y="${y + 4}" font-size="12" fill="#172033">${esc(c.name)} — ${esc(c.phase)} — ${fmt(c.p, 0)} VA — ${x.secao} mm² — ${x.disjuntor.In ?? "—"} A</text>`;
	});
	return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" width="100%" style="background:#fff">
    <rect x="20" y="20" width="150" height="40" rx="6" fill="#0f172a"/>
    <text x="95" y="45" font-size="13" fill="#fff" text-anchor="middle">QDC</text>
    ${rows}
  </svg>`;
}

/* --------------------------------------------------------------------------
   17. RENDERIZAÇÃO DA INTERFACE
   -------------------------------------------------------------------------- */
function renderRooms() {
	const el = $("rooms");
	if (!S.rooms.length) {
		el.innerHTML = '<div class="info-box">Nenhum cômodo cadastrado.</div>';
		return;
	}
	el.innerHTML = S.rooms
		.map(
			(
				r,
			) => `<div class="room-card"><div class="panel-head"><h3>${esc(r.name)}</h3><button class="danger" onclick="removeRoom('${r.id}')">Remover</button></div>
    <div class="form-grid">
      <label>Nome<input value="${esc(r.name)}" onchange="roomChange('${r.id}','name',this.value)"></label>
      <label>Tipo<select onchange="roomChange('${r.id}','type',this.value)">${ROOM_TYPES.map((t) => `<option ${t === r.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Comprimento (m)<input type="number" step=".01" min="0" value="${r.l}" onchange="roomChange('${r.id}','l',this.value)"></label>
      <label>Largura (m)<input type="number" step=".01" min="0" value="${r.w}" onchange="roomChange('${r.id}','w',this.value)"></label>
    </div>
    <p><b>Área:</b> ${fmt(calcularArea(r))} m² &nbsp; <b>Perímetro:</b> ${fmt(calcularPerimetro(r))} m</p></div>`,
		)
		.join("");
}
function renderLighting() {
	$("lighting").innerHTML = S.rooms.length
		? `<div class="table-wrap"><table class="data-table"><tr><th>Ambiente</th><th>Área</th><th>Carga de dimensionamento</th><th>Potência nominal instalada (opcional)</th></tr>
    ${S.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${fmt(calcularArea(r))} m²</td><td><b>${calcularIluminacao(calcularArea(r))} VA</b></td><td><input type="number" min="0" value="${r.lamp || 0}" onchange="roomChange('${r.id}','lamp',this.value)"></td></tr>`).join("")}
    </table></div>`
		: '<div class="info-box">Cadastre os cômodos.</div>';
}
function renderTugs() {
	$("tugs").innerHTML = S.rooms.length
		? S.rooms
				.map((r) => {
					const min = calcularTUGMinimo(r),
						adotado = r.tugs ?? min;
					return `<div class="room-card"><h3>${esc(r.name)}</h3>
      <div class="form-grid">
        <label>Mínimo sugerido<input disabled value="${min}"></label>
        <label>Quantidade adotada<input type="number" min="0" value="${adotado}" onchange="roomChange('${r.id}','tugs',this.value)"></label>
        <label>VA por TUG<input type="number" min="0" value="${r.tugVA ?? 100}" onchange="roomChange('${r.id}','tugVA',this.value)"></label>
        <label>Total adotado (VA)<input disabled value="${fmt(adotado * (r.tugVA ?? 100))}"></label>
      </div>
      ${adotado < min ? `<p class="mini" style="color:#b45309">Quantidade adotada (${adotado}) abaixo do mínimo sugerido (${min}) pelo critério do protótipo.</p>` : `<p class="mini">Mínimo sugerido pelo critério do protótipo: ${min}. Quantidade adotada: ${adotado}.</p>`}
    </div>`;
				})
				.join("")
		: '<div class="info-box">Cadastre os cômodos.</div>';
}
function renderLoads() {
	$("loads").innerHTML = S.loads.length
		? S.loads
				.map(
					(
						l,
					) => `<div class="load-card"><div class="panel-head"><h3>${esc(l.name || l.type)}</h3><button class="danger" onclick="removeLoad('${l.id}')">Remover</button></div>
    <div class="form-grid">
      <label>Tipo<select onchange="loadChange('${l.id}','type',this.value)">${TYPES.map((t) => `<option ${t === l.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Ambiente<select onchange="loadChange('${l.id}','room',this.value)"><option value="">—</option>${S.rooms.map((r) => `<option value="${r.id}" ${r.id === l.room ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
      <label>Potência (W)<input type="number" min="0" value="${l.p}" onchange="loadChange('${l.id}','p',this.value)"></label>
      <label>Tensão (V)<input type="number" min="1" value="${l.v}" onchange="loadChange('${l.id}','v',this.value)"></label>
      <label>FP<input type="number" min=".01" max="1" step=".01" value="${l.fp}" onchange="loadChange('${l.id}','fp',this.value)"></label>
      <label>Quantidade<input type="number" min="1" value="${l.q}" onchange="loadChange('${l.id}','q',this.value)"></label>
      <label>Distância (m)<input type="number" min="0" value="${l.d}" onchange="loadChange('${l.id}','d',this.value)"></label>
      <label>Nome<input value="${esc(l.name || "")}" onchange="loadChange('${l.id}','name',this.value)"></label>
    </div></div>`,
				)
				.join("")
		: '<div class="info-box">Nenhum equipamento específico.</div>';
}

/* --------------------------------------------------------------------------
   MONTAGEM / RECONSTRUÇÃO DOS CIRCUITOS
   --------------------------------------------------------------------------
   Reconstrói a lista de circuitos a partir de cômodos, iluminação, TUG e
   TUE, classifica o tipo de tensão de cada um (fase-neutro / fase-fase /
   trifásico) e aplica o balanceamento de fases (respeitando travas
   manuais em S.faseOverride).
   -------------------------------------------------------------------------- */
function rebuildCircuits() {
	const arr = [];
	if (S.rooms.length) {
		arr.push({
			id: "circ-iluminacao",
			name: "C1 - Iluminação",
			type: "Iluminação",
			p: S.rooms.reduce((t, r) => t + calcularIluminacao(calcularArea(r)), 0),
			d: N(S.installation.distAlim) || 10,
			fp: 1,
			tensaoTipo: "fn",
			roomRef: null,
		});
	}
	if (S.rooms.length) {
		arr.push({
			id: "circ-tug",
			name: "C2 - TUG",
			type: "TUG",
			p: S.rooms.reduce((t, r) => t + (r.tugs ?? calcularTUGMinimo(r)) * (r.tugVA ?? 100), 0),
			d: N(S.installation.distAlim) || 10,
			fp: 1,
			tensaoTipo: "fn",
			roomRef: null,
		});
	}
	S.loads.forEach((l, i) => {
		arr.push({
			id: "circ-load-" + l.id,
			name: `C${i + 3} - ${l.name || l.type}`,
			type: "TUE",
			p: N(l.p) * N(l.q || 1),
			d: N(l.d || 10),
			fp: N(l.fp || 1),
			tensaoTipo: tensaoTipoDaCarga(N(l.v)),
			loadId: l.id,
			roomRef: l.room || null,
		});
	});
	// preserva tipo de ligação manual (ex.: forçar trifásico) já escolhido antes
	arr.forEach((c) => {
		const prev = S.circuits.find((p) => p.id === c.id);
		if (prev && prev.tensaoTipoManual) {
			c.tensaoTipo = prev.tensaoTipo;
			c.tensaoTipoManual = true;
		}
	});
	S.circuits = arr;
	const bal = calcularBalanceamento();
	S.circuits.forEach((c) => {
		c.phase = bal.assign[c.id];
	});
	renderAll();
}
function tipoLigacaoChange(id, tipo) {
	const c = S.circuits.find((x) => x.id === id);
	if (!c) return;
	c.tensaoTipo = tipo;
	c.tensaoTipoManual = true;
	const opts = opcoesFasePara(tipo);
	if (!opts.includes(c.phase)) {
		delete S.faseOverride[c.id];
		c.phase = opts[0];
	}
	renderAll();
}
function faseManualChange(id, fase) {
	S.faseOverride[id] = fase;
	const bal = calcularBalanceamento();
	S.circuits.forEach((c) => {
		c.phase = bal.assign[c.id];
	});
	renderAll();
}
function resetBalanceamento() {
	S.faseOverride = {};
	const bal = calcularBalanceamento();
	S.circuits.forEach((c) => {
		c.phase = bal.assign[c.id];
	});
	renderAll();
}

function renderCircuits() {
	$("circuits").innerHTML = S.circuits.length
		? S.circuits
				.map((c) => {
					const opts = opcoesFasePara(c.tensaoTipo || "fn");
					const ligacaoOpts =
						S.installation.sistema === "mono"
							? [["fn", "Fase-neutro"]]
							: S.installation.sistema === "bi"
								? [
										["fn", "Fase-neutro"],
										["ff", "Fase-fase"],
									]
								: [
										["fn", "Fase-neutro"],
										["ff", "Fase-fase"],
										["3f", "Trifásico (A-B-C)"],
									];
					return `<div class="circuit-card"><div class="panel-head"><h3>${esc(c.name)}</h3><span class="tag">${c.type}</span></div>
      <div class="form-grid">
        <label>Nome<input value="${esc(c.name)}" onchange="circuitChange('${c.id}','name',this.value)"></label>
        <label>Potência VA<input type="number" value="${c.p}" onchange="circuitChange('${c.id}','p',this.value)"></label>
        <label>Distância m<input type="number" value="${c.d}" onchange="circuitChange('${c.id}','d',this.value)"></label>
        <label>FP<input type="number" min=".01" max="1" step=".01" value="${c.fp}" onchange="circuitChange('${c.id}','fp',this.value)"></label>
        <label>Tipo de ligação<select onchange="tipoLigacaoChange('${c.id}',this.value)">${ligacaoOpts.map(([v, l]) => `<option value="${v}" ${(c.tensaoTipo || "fn") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Fase<select onchange="faseManualChange('${c.id}',this.value)">${opts.map((o) => `<option ${c.phase === o ? "selected" : ""}>${o}</option>`).join("")}</select></label>
      </div></div>`;
				})
				.join("")
		: '<div class="info-box">Clique em Recalcular.</div>';
}

function renderDimensioning() {
	if (!S.circuits.length) {
		$("dimensioning").innerHTML = '<div class="info-box">Crie os circuitos primeiro.</div>';
		return;
	}
	const rows = S.circuits
		.map((c) => {
			const x = calc(c);
			c.calc = x;
			const statusClass = x.status === "ATENDE" ? "ok" : x.status === "NÃO ATENDE" ? "bad" : "warn";
			return `<tr><td>${esc(c.name)}</td><td>${c.phase}</td><td>${fmt(c.p, 0)} VA</td><td>${x.Ib.toFixed(2)} A</td>
      <td>${x.secao} mm²</td><td>${x.IzBase.toFixed(1)} A</td><td>${x.k1.toFixed(2)}</td><td>${x.k2.toFixed(2)}</td><td>${x.Iz.toFixed(1)} A</td>
      <td>${x.disjuntor.In ?? "—"} A</td><td>${x.pe.secaoPE} mm²</td>
      <td>${x.queda.dropV.toFixed(2)} V (${x.queda.dropPct.toFixed(2)}%)</td>
      <td><span class="tag ${statusClass}">${x.status}</span></td></tr>`;
		})
		.join("");
	const installed = S.circuits.reduce((t, c) => t + c.p, 0);
	const demand = S.circuits.reduce((t, c) => t + calc(c).demanda.potenciaDemanda, 0);
	const project = demand * (1 + N(S.installation.expansao) / 100);
	$("dimensioning").innerHTML = `<div class="cards">
    <div class="metric"><small>Potência instalada</small><strong>${(installed / 1000).toFixed(2)} kVA</strong></div>
    <div class="metric"><small>Demanda calculada</small><strong>${(demand / 1000).toFixed(2)} kVA</strong></div>
    <div class="metric"><small>Potência de projeto (+ expansão)</small><strong>${(project / 1000).toFixed(2)} kVA</strong></div>
    <div class="metric"><small>Fatores de correção</small><strong>K1=${fatorK1().toFixed(2)} · K2=${fatorK2().toFixed(2)}</strong></div>
  </div>
  <div class="table-wrap" style="margin-top:18px"><table class="data-table">
    <tr><th>Circuito</th><th>Fase</th><th>Potência</th><th>Ib</th><th>Seção</th><th>Iz base</th><th>K1</th><th>K2</th><th>Iz corrigida</th><th>Disjuntor In</th><th>PE</th><th>ΔV</th><th>Status</th></tr>
    ${rows}
  </table></div>
  <div class="warn-box"><b>Limitação:</b> ${REFERENCE_NOTICE} O método de instalação, agrupamento e temperatura influenciam o resultado através de K1 e K2, mas os valores-base de capacidade de condução usados pelo protótipo não são uma reprodução da tabela da NBR 5410.</div>`;
}

function renderQdc() {
	const bal = calcularBalanceamento();
	const rows = S.circuits
		.map((c) => {
			const x = calc(c);
			return `<tr><td>${esc(c.name)}</td><td>${c.type}</td><td>${c.phase}</td><td>${fmt(c.p, 0)} VA</td><td>${x.secao} mm²</td><td>${x.disjuntor.In ?? "—"} A</td><td>${x.pe.secaoPE} mm²</td><td>${x.eletroduto.comercial ?? "—"} mm</td><td><span class="tag ${x.dr.status === "ATENDE" ? "ok" : "warn"}">${x.dr.status}</span></td></tr>`;
		})
		.join("");
	$("qdc").innerHTML = `<div class="cards">
    <div class="metric"><small>Fase A</small><strong>${(bal.totals.A / 1000).toFixed(2)} kVA</strong></div>
    <div class="metric"><small>Fase B</small><strong>${(bal.totals.B / 1000).toFixed(2)} kVA</strong></div>
    <div class="metric"><small>Fase C</small><strong>${(bal.totals.C / 1000).toFixed(2)} kVA</strong></div>
    <div class="metric"><small>Desequilíbrio</small><strong>${bal.imbalance.toFixed(1)}%</strong></div>
  </div>
  <div style="margin:16px 0"><button class="secondary" onclick="resetBalanceamento()">Sugerir balanceamento automático</button></div>
  <div class="table-wrap"><table class="data-table"><tr><th>Circuito</th><th>Tipo</th><th>Fase</th><th>Potência</th><th>Seção</th><th>Disjuntor</th><th>PE</th><th>Eletroduto</th><th>DR</th></tr>${rows}</table></div>
  <h3 style="margin-top:22px">Diagrama unifilar</h3>
  <div class="table-wrap" style="padding:10px">${diagramaSVG()}</div>
  <div class="info-box"><b>DPS:</b> ${verificarDPS().observacao}</div>
  <div class="info-box"><b>Proteções complementares:</b> DR/IDR e DPS aparecem como itens de verificação no memorial. A escolha final depende do esquema de aterramento, das características da instalação e dos critérios normativos aplicáveis; o software não realiza uma seleção universal automática.</div>`;
}

function renderAll() {
	renderAlerts();
	renderRooms();
	renderLighting();
	renderTugs();
	renderLoads();
	renderCircuits();
	renderDimensioning();
	renderQdc();
}

/* --------------------------------------------------------------------------
   HANDLERS DE EDIÇÃO
   -------------------------------------------------------------------------- */
function roomChange(id, k, v) {
	const r = S.rooms.find((x) => x.id === id);
	if (!r) return;
	r[k] = ["l", "w", "lamp", "tugs", "tugVA"].includes(k) ? N(v) : v;
	rebuildCircuits();
}
function loadChange(id, k, v) {
	const l = S.loads.find((x) => x.id === id);
	if (!l) return;
	l[k] = ["p", "v", "fp", "q", "d"].includes(k) ? N(v) : v;
	rebuildCircuits();
}
function circuitChange(id, k, v) {
	const c = S.circuits.find((x) => x.id === id);
	if (!c) return;
	c[k] = ["p", "d", "fp"].includes(k) ? N(v) : v;
	renderAll();
}
// Correção do bug de exclusão de cômodos: cargas referenciam o cômodo por
// ID (não por nome). Ao excluir um cômodo, avisa se há cargas associadas
// e desvincula corretamente (não deixa referência quebrada).
function removeRoom(id) {
	const associadas = S.loads.filter((l) => l.room === id);
	if (
		associadas.length &&
		!confirm(
			`Este cômodo possui ${associadas.length} equipamento(s) associado(s). Eles ficarão sem cômodo definido. Deseja continuar?`,
		)
	)
		return;
	S.rooms = S.rooms.filter((x) => x.id !== id);
	S.loads = S.loads.map((l) => (l.room === id ? { ...l, room: "" } : l));
	rebuildCircuits();
}
function removeLoad(id) {
	S.loads = S.loads.filter((x) => x.id !== id);
	rebuildCircuits();
}

$("addRoom").onclick = () => {
	S.rooms.push({ id: uid(), name: `Cômodo ${S.rooms.length + 1}`, type: "Quarto", l: 3, w: 3, tugVA: 100, lamp: 0 });
	renderAll();
};
$("addLoad").onclick = () => {
	S.loads.push({
		id: uid(),
		type: "Chuveiro",
		name: "",
		room: "",
		p: 5500,
		v: S.installation.vf,
		fp: 1,
		q: 1,
		d: 10,
	});
	renderAll();
};
$("rebuildCircuits").onclick = rebuildCircuits;

function bind() {
	[
		"tipo",
		"sistema",
		"vf",
		"vff",
		"freq",
		"material",
		"isolacao",
		"metodo",
		"temp",
		"agrupamento",
		"quedaLimite",
		"distAlim",
		"expansao",
		"ocupacaoEletroduto",
	].forEach((id) => {
		if (!$(id)) return;
		$(id).addEventListener("change", () => {
			const v = $(id).value;
			const numeric = [
				"vf",
				"vff",
				"freq",
				"temp",
				"agrupamento",
				"quedaLimite",
				"distAlim",
				"expansao",
				"ocupacaoEletroduto",
			];
			S.installation[id] = numeric.includes(id) ? N(v) : v;
			rebuildCircuits();
		});
	});
}
function showStep(x) {
	S.step = x;
	document.querySelectorAll(".step-panel").forEach((p) => p.classList.toggle("active", N(p.dataset.panel) === x));
	document.querySelectorAll(".step").forEach((b) => b.classList.toggle("active", N(b.dataset.step) === x));
	$("progress").textContent = `Etapa ${x} de 8`;
	$("prev").disabled = x === 1;
	$("next").textContent = x === 8 ? "Finalizado" : "Próxima →";
}
document.querySelectorAll(".step").forEach((b) => (b.onclick = () => showStep(N(b.dataset.step))));
$("prev").onclick = () => showStep(Math.max(1, S.step - 1));
$("next").onclick = () => showStep(Math.min(8, S.step + 1));

/* --------------------------------------------------------------------------
   EXEMPLO (dados de teste do enunciado do projeto)
   -------------------------------------------------------------------------- */
function example() {
	Object.assign(S.installation, {
		tipo: "residencial",
		sistema: "bi",
		vf: 127,
		vff: 220,
		freq: 60,
		material: "Cu",
		isolacao: "PVC70",
		metodo: "B1",
		temp: 30,
		agrupamento: 1,
		quedaLimite: 4,
		distAlim: 12,
		expansao: 20,
		ocupacaoEletroduto: 40,
	});
	const sala = uid(),
		quarto = uid(),
		cozinha = uid(),
		banheiro = uid();
	S.rooms = [
		{ id: sala, name: "Sala", type: "Sala", l: 4, w: 3, tugs: 3, tugVA: 100, lamp: 18 },
		{ id: quarto, name: "Quarto", type: "Quarto", l: 3.5, w: 3, tugs: 2, tugVA: 100, lamp: 12 },
		{ id: cozinha, name: "Cozinha", type: "Cozinha", l: 3, w: 2.5, tugs: 4, tugVA: 100, lamp: 12 },
		{ id: banheiro, name: "Banheiro", type: "Banheiro", l: 2, w: 2, tugs: 1, tugVA: 600, lamp: 10 },
	];
	S.loads = [
		{ id: uid(), type: "Chuveiro", name: "Chuveiro", room: banheiro, p: 5500, v: 220, fp: 1, q: 1, d: 12 },
		{ id: uid(), type: "Forno elétrico", name: "Forno", room: cozinha, p: 3000, v: 220, fp: 0.95, q: 1, d: 10 },
		{
			id: uid(),
			type: "Ar-condicionado",
			name: "Ar-condicionado",
			room: quarto,
			p: 1200,
			v: 127,
			fp: 0.9,
			q: 1,
			d: 15,
		},
	];
	S.faseOverride = {};
	rebuildCircuits();
	showStep(1);
	syncInputs();
}
function syncInputs() {
	Object.entries(S.installation).forEach(([k, v]) => {
		if ($(k)) $(k).value = v;
	});
}
$("btnExemplo").onclick = example;
$("btnReset").onclick = () => {
	if (confirm("Limpar projeto?")) location.reload();
};

/* --------------------------------------------------------------------------
   19. PERSISTÊNCIA — camada isolada, substituível futuramente por API/BD
   -------------------------------------------------------------------------- */
const Persistence = {
	exportJSON() {
		return JSON.stringify(S, null, 2);
	},
	importJSON(text) {
		const x = JSON.parse(text);
		Object.assign(S, x);
		if (!S.faseOverride) S.faseOverride = {};
	},
	saveLocal() {
		try {
			localStorage.setItem("dimensionaLar-projeto", this.exportJSON());
		} catch (e) {
			/* localStorage indisponível — ignorar silenciosamente */
		}
	},
	loadLocal() {
		try {
			const t = localStorage.getItem("dimensionaLar-projeto");
			if (t) this.importJSON(t);
		} catch (e) {
			/* nada salvo ou indisponível */
		}
	},
};
$("btnExportar").onclick = () => {
	const blob = new Blob([Persistence.exportJSON()], { type: "application/json" }),
		a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "dimensionaLar-projeto.json";
	a.click();
	URL.revokeObjectURL(a.href);
};
$("importarJson").onchange = (e) => {
	const f = e.target.files[0];
	if (!f) return;
	const rd = new FileReader();
	rd.onload = () => {
		try {
			Persistence.importJSON(rd.result);
			syncInputs();
			rebuildCircuits();
			showStep(1);
		} catch {
			alert("JSON inválido.");
		}
	};
	rd.readAsText(f);
};

/* --------------------------------------------------------------------------
   18. RELATÓRIO / MEMORIAL DE CÁLCULO
   -------------------------------------------------------------------------- */
function gerarRelatorioHTML() {
	const ins = S.installation;
	const bal = calcularBalanceamento();
	const installed = S.circuits.reduce((t, c) => t + c.p, 0);
	const results = S.circuits.map((c) => ({ c, x: calc(c) }));
	const demand = results.reduce((t, r) => t + r.x.demanda.potenciaDemanda, 0);
	const project = demand * (1 + N(ins.expansao) / 100);

	const linhaCalc = (titulo, entrada, formula, resultado, criterio, conclusao) =>
		`<tr><td><b>${esc(titulo)}</b></td><td>${entrada}</td><td>${esc(formula)}</td><td>${resultado}</td><td>${criterio}</td><td>${conclusao}</td></tr>`;

	const memorialRows = results
		.map(({ c, x }) =>
			linhaCalc(
				c.name,
				`P=${fmt(c.p, 0)} VA, V=${x.V} V, fp=${fmt(c.fp)}, L=${fmt(c.d, 1)} m, fase=${c.phase}`,
				c.phase === "A-B-C" ? "Ib=P/(√3·Vff·fp)" : "Ib=P/(V·fp)",
				`Ib=${x.Ib.toFixed(2)} A · S=${x.secao} mm² · Iz=${x.Iz.toFixed(1)} A · In=${x.disjuntor.In ?? "—"} A · ΔV=${x.queda.dropV.toFixed(2)} V (${x.queda.dropPct.toFixed(2)}%)`,
				`Iz≥Ib; Ib≤In≤Iz; ΔV%≤${x.queda.limite}%`,
				`<span class="tag ${x.status === "ATENDE" ? "ok" : x.status === "NÃO ATENDE" ? "bad" : "warn"}">${x.status}</span>`,
			),
		)
		.join("");

	const errs = validateAll();

	return `<!doctype html><meta charset="utf-8"><title>Memorial — Ferramenta para auxílio no dimensionamento de instalações elétricas</title>
  <style>
    body{font:13px/1.5 Arial;max-width:1150px;margin:30px auto;color:#111;padding:0 16px}
    table{border-collapse:collapse;width:100%;margin:10px 0}
    th,td{border:1px solid #ccc;padding:6px;vertical-align:top}
    th{background:#eee;text-align:left}
    .box{padding:12px;background:#eef6ff;margin:14px 0;border-radius:6px}
    .warn{background:#fff7ed}
    h1{margin-bottom:2px}
    h2{margin-top:28px;border-bottom:2px solid #0f172a;padding-bottom:4px}
    .tag{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;background:#e2e8f0}
    .tag.ok{background:#dcfce7;color:#166534}.tag.warn{background:#fef3c7;color:#92400e}.tag.bad{background:#fee2e2;color:#991b1b}
    @media print{ .box{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
  </style>

  <h1>Ferramenta para auxílio no dimensionamento de instalações elétricas</h1>
  <p><b>Memorial de cálculo orientativo — uso acadêmico/educacional.</b></p>
  <p>Esta ferramenta possui finalidade acadêmica e educacional e fornece apoio preliminar ao dimensionamento. O resultado não substitui projeto elétrico, análise das condições reais da instalação, documentação técnica, normas aplicáveis ou a responsabilidade de profissional habilitado.</p>

  <h2>1. Identificação do projeto</h2>
  <p>Nome da ferramenta: <b>Ferramenta para auxílio no dimensionamento de instalações elétricas</b>. Gerado em ${new Date().toLocaleString("pt-BR")}.</p>

  <h2>2. Características da instalação</h2>
  <table><tr><th>Tipo</th><th>Sistema</th><th>V fase-neutro</th><th>V entre fases</th><th>Frequência</th><th>Material</th><th>Isolação</th><th>Método</th><th>Temp.</th><th>Agrupamento</th><th>Limite ΔV</th><th>Dist. alimentador</th><th>Expansão</th></tr>
  <tr><td>${esc(ins.tipo)}</td><td>${esc(ins.sistema)}</td><td>${ins.vf} V</td><td>${ins.vff} V</td><td>${ins.freq} Hz</td><td>${ins.material}</td><td>${ISOLATION_LABEL[ins.isolacao]}</td><td>${METHODS[ins.metodo]?.label ?? ins.metodo}</td><td>${ins.temp} °C</td><td>${ins.agrupamento}</td><td>${ins.quedaLimite}%</td><td>${ins.distAlim} m</td><td>${ins.expansao}%</td></tr></table>

  <h2>3. Cômodos</h2>
  <table><tr><th>Nome</th><th>Tipo</th><th>Comprimento</th><th>Largura</th><th>Área</th><th>Perímetro</th></tr>
  ${S.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>${fmt(r.l)} m</td><td>${fmt(r.w)} m</td><td>${fmt(calcularArea(r))} m²</td><td>${fmt(calcularPerimetro(r))} m</td></tr>`).join("")}</table>

  <h2>4. Iluminação</h2>
  <p>Critério de área: 100 VA até 6 m², mais 60 VA por cada 4 m² inteiros excedentes. Critério de referência utilizado pela ferramenta; confirmar junto à edição normativa adotada.</p>
  <table><tr><th>Ambiente</th><th>Área</th><th>Carga de dimensionamento</th></tr>${S.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${fmt(calcularArea(r))} m²</td><td>${calcularIluminacao(calcularArea(r))} VA</td></tr>`).join("")}</table>

  <h2>5. TUG</h2>
  <table><tr><th>Ambiente</th><th>Mínimo sugerido</th><th>Quantidade adotada</th><th>VA/tomada</th><th>Total</th></tr>
  ${S.rooms
		.map((r) => {
			const min = calcularTUGMinimo(r),
				ad = r.tugs ?? min;
			return `<tr><td>${esc(r.name)}</td><td>${min}</td><td>${ad}</td><td>${r.tugVA ?? 100}</td><td>${fmt(ad * (r.tugVA ?? 100))} VA</td></tr>`;
		})
		.join("")}</table>

  <h2>6. TUE</h2>
  <table><tr><th>Equipamento</th><th>Ambiente</th><th>Potência</th><th>Tensão</th><th>FP</th><th>Quantidade</th><th>Distância</th></tr>
  ${S.loads.map((l) => `<tr><td>${esc(l.name || l.type)}</td><td>${esc((roomById(l.room) || {}).name || "—")}</td><td>${l.p} W</td><td>${l.v} V</td><td>${l.fp}</td><td>${l.q}</td><td>${l.d} m</td></tr>`).join("")}</table>

  <h2>7. Potência instalada</h2>
  <p>Potência instalada total: <b>${(installed / 1000).toFixed(2)} kVA</b> (soma das potências de todos os circuitos).</p>

  <h2>8. Demanda</h2>
  <table><tr><th>Circuito</th><th>Potência instalada</th><th>Fator de demanda</th><th>Origem do fator</th><th>Potência de demanda</th></tr>
  ${results.map(({ c, x }) => `<tr><td>${esc(c.name)}</td><td>${fmt(c.p, 0)} VA</td><td>${x.demanda.fator}</td><td>${x.demanda.manual ? "Fator de demanda adotado manualmente." : "Valor default do protótipo (1,0) — não é uma tabela normativa de demanda."}</td><td>${fmt(x.demanda.potenciaDemanda, 0)} VA</td></tr>`).join("")}</table>
  <p>Demanda total: <b>${(demand / 1000).toFixed(2)} kVA</b>. Potência de projeto com reserva de expansão de ${ins.expansao}%: <b>${(project / 1000).toFixed(2)} kVA</b>.</p>

  <h2>9. Divisão dos circuitos</h2>
  <table><tr><th>Circuito</th><th>Tipo</th><th>Tipo de ligação</th><th>Fase</th><th>Potência</th></tr>
  ${S.circuits.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.type}</td><td>${c.tensaoTipo}</td><td>${c.phase}</td><td>${fmt(c.p, 0)} VA</td></tr>`).join("")}</table>
  <p>Circuitos de iluminação e TUG são mantidos separados; cargas de maior potência (TUE) recebem circuito próprio. A distribuição de fases é sugerida pelo algoritmo de balanceamento (seção 18) e pode ser ajustada manualmente pelo usuário.</p>

  <h2>10 a 17. Memorial de cálculo por circuito</h2>
  <p>Cada linha segue a estrutura: <b>Entrada → Fórmula → Resultado → Critério → Conclusão</b>.</p>
  <table><tr><th>Circuito</th><th>Entrada</th><th>Fórmula</th><th>Resultado</th><th>Critério</th><th>Conclusão</th></tr>${memorialRows}</table>

  <h2>18. Balanceamento de fases</h2>
  <p>Fase A: ${(bal.totals.A / 1000).toFixed(2)} kVA · Fase B: ${(bal.totals.B / 1000).toFixed(2)} kVA · Fase C: ${(bal.totals.C / 1000).toFixed(2)} kVA · Desequilíbrio: <b>${bal.imbalance.toFixed(1)}%</b>.</p>
  <p>Algoritmo: heurística gulosa que aloca cada circuito (do de maior para o de menor potência) à fase (ou par de fases) que minimiza a diferença entre a fase mais e a menos carregada no momento da alocação. Alocações podem ser travadas manualmente pelo usuário.</p>

  <h2>19. QDC</h2>
  <table><tr><th>Circuito</th><th>Fase</th><th>Seção</th><th>Disjuntor</th><th>PE</th><th>Eletroduto</th><th>DR</th></tr>
  ${results.map(({ c, x }) => `<tr><td>${esc(c.name)}</td><td>${c.phase}</td><td>${x.secao} mm²</td><td>${x.disjuntor.In ?? "—"} A</td><td>${x.pe.secaoPE} mm²</td><td>${x.eletroduto.comercial ?? "—"} mm</td><td>${x.dr.status}</td></tr>`).join("")}</table>

  <h2>20. Diagrama unifilar</h2>
  ${diagramaSVG()}

  <h2>21. Verificações</h2>
  <p><b>DPS:</b> ${verificarDPS().observacao}</p>
  <p><b>Neutro:</b> circuitos com condutor neutro apresentam status "NECESSITA VERIFICAÇÃO" — o dimensionamento definitivo depende de equilíbrio de fases, presença de harmônicas e das cargas efetivamente conectadas.</p>
  ${errs.length ? `<div class="box warn"><b>Pendências de entrada (${errs.length}):</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "<p>Nenhuma pendência de validação de entrada identificada no momento da geração deste relatório.</p>"}

  <h2>22. Limitações</h2>
  <div class="box warn">
    <p>${REFERENCE_NOTICE}</p>
    <p>As tabelas de capacidade de condução, fatores de correção (K1/K2), diâmetros de condutor e taxa de ocupação de eletroduto usados por este protótipo são valores de referência configuráveis, definidos para fins de funcionamento didático da ferramenta. Eles <b>não</b> são uma reprodução das tabelas da ABNT NBR 5410 e devem ser confirmados/substituídos conforme a edição normativa adotada antes de qualquer uso além do acadêmico.</p>
    <p>O dimensionamento de DR e DPS apresentado é apenas indicativo/orientativo; não há seleção normativa completa automática.</p>
  </div>

  <h2>23. Referências</h2>
  <ul>
    <li>ABNT NBR 5410:2004, Versão Corrigida:2008 (edição de referência adotada, conforme consulta ao catálogo oficial da ABNT).</li>
    <li>CREDER, Hélio. <i>Instalações Elétricas</i>, 16ª edição.</li>
    <li>Consultas conceituais (fluxo/funcionalidades, sem cópia de código, texto, identidade visual ou conteúdo protegido): Portal dos Eletricistas — simulador de QDC e calculadora de queda de tensão.</li>
  </ul>
  `;
}
$("btnRelatorio").onclick = () => {
	const w = window.open();
	w.document.write(gerarRelatorioHTML());
	w.document.close();
	w.print();
};

/* --------------------------------------------------------------------------
   20. INICIALIZAÇÃO
   -------------------------------------------------------------------------- */
bind();
syncInputs();
rebuildCircuits();
showStep(1);
