'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  escapeMarkdown,
} = require('discord.js');

const TZ = process.env.TIMEZONE || 'Europe/Lisbon';
const UNIT = process.env.POINTS_LABEL || 'pontos';
const ICON = process.env.POINTS_EMOJI || '🏆';

const COLOR = /^#[a-f\d]{6}$/i.test(process.env.MATCHDAY_COLOR || '')
  ? process.env.MATCHDAY_COLOR
  : '#E10014';

const BASE = { 1: 2, 2: 4, 3: 8 };
const EMOJIS = { 1: '🤙', 2: '⚡', 3: '🔥' };

const NAMES = {
  1: 'Chill',
  2: 'Jogador',
  3: 'Muuuuito jogador',
};

const EDITION = {
  title: 'BETCLIC MATCHDAY',
  description: 'Descobre aqui os próximos MatchDays.',
  blocks: {
    mardi: '',
    mercredi: '',
    jeudi: '',
    weekend: '',
  },
};

const GROUPS = {
  mardi: '⚽ TERÇA-FEIRA',
  mercredi: '⚽ QUARTA-FEIRA',
  jeudi: '⚽ QUINTA-FEIRA',
  weekend: '🔥 FIM DE SEMANA',
};

function fixtures(text) {
  return String(text || '')
    .split(/\s+\/\s+|\r?\n|\\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

function programBlocks(p) {
  return Object.entries(GROUPS)
    .filter(([key]) => fixtures(p.blocks?.[key]).length);
}

function validateProgram(p) {
  dateKey(p.start);
  dateKey(p.end);

  need(
    p.start <= p.end,
    'A data de início deve ser anterior ou igual à data de fim.',
  );

  for (const [key] of programBlocks(p)) {
    need(
      fixtures(p.blocks[key])
        .map(x => '• ' + safe(x))
        .join('\n').length <= 1000,
      `O grupo ${key} é demasiado longo: encurta os nomes ou os horários.`,
    );
  }
}

const quiet = { parse: [] };
const uid = () => randomUUID().replaceAll('-', '').slice(0, 16);

class UserError extends Error {}

function need(ok, text) {
  if (!ok) throw new UserError(text);
}

const safe = x =>
  escapeMarkdown(String(x)).replaceAll('@', '@\u200b');

const digest = x =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');

const copy = x => structuredClone(x);

const clean = (x, max, label) => {
  const s = String(x || '')
    .trim()
    .replace(/[\u2013\u2014]/g, '-');

  need(
    s.length > 0 && s.length <= max,
    `${label}: entre 1 e ${max} caracteres.`,
  );

  return s;
};

function parts(ms) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value]),
  );
}

function day(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateKey(s) {
  need(
    /^\d{4}-\d{2}-\d{2}$/.test(s || ''),
    'Formato da data: AAAA-MM-DD.',
  );

  const t = Date.parse(s + 'T12:00:00Z');

  need(
    Number.isFinite(t) &&
      new Date(t).toISOString().slice(0, 10) === s,
    'Data inválida.',
  );

  return s;
}

function shift(s, n) {
  return new Date(
    Date.parse(dateKey(s) + 'T12:00:00Z') + n * 86400000,
  )
    .toISOString()
    .slice(0, 10);
}

function monday(s) {
  const w = new Date(s + 'T12:00:00Z').getUTCDay();
  return shift(s, -(w === 0 ? 6 : w - 1));
}

function sportDay(ms = Date.now()) {
  return Number(parts(ms).hour) < 12
    ? shift(day(ms), -1)
    : day(ms);
}

function time(ms) {
  const p = parts(ms);
  return `${p.day}/${p.month}/${p.year} às ${p.hour}:${p.minute}`;
}

function dateLabel(s) {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(s + 'T12:00:00Z'));
}

function parseTime(s) {
  let text = String(s || '').trim();

  if (/^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/.test(text)) {
    text = text.slice(6) + ' ' + text.slice(0, 5);
  }

  need(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(text),
    'Formato da hora: AAAA-MM-DD HH:mm, por exemplo 2026-11-10 09:00.',
  );

  dateKey(text.slice(0, 10));

  const utc = Date.parse(text.replace(' ', 'T') + ':00Z');
  const matches = [];

  for (let n = -840; n <= 840; n += 15) {
    const t = utc + n * 60000;
    const p = parts(t);

    if (
      `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === text
    ) {
      matches.push(t);
    }
  }

  need(
    matches.length === 1,
    matches.length
      ? 'Hora ambígua devido à mudança de hora. Escolhe outro horário.'
      : 'Esta data ou hora não existe.',
  );

  return matches[0];
}

function imageURL(s) {
  if (!s) return '';

  let u;

  try {
    u = new URL(s);
  } catch {
    throw new UserError('URL da imagem inválido.');
  }

  need(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      s.length <= 1000,
    'Utiliza um URL HTTPS de imagem com menos de 1 000 caracteres.',
  );

  return s;
}

function odds(s) {
  const n = Number(String(s).trim().replace(',', '.'));

  need(
    Number.isFinite(n) && n >= 1 && n <= 10000,
    'Odd inválida: utiliza, por exemplo, 1,80.',
  );

  return String(s).trim();
}

const closeAt = m => Date.parse(m.closingTimeUTC);

function isOpen(m, now = Date.now()) {
  return (
    m.status === 'open' &&
    m.result === null &&
    now < closeAt(m)
  );
}

function getMatch(s, id) {
  const m = s.matches[id];

  need(
    m && m.status !== 'deleted',
    'Jogo não encontrado. Utiliza /list-matches para consultar o ID.',
  );

  return m;
}

function initial() {
  return {
    schema: 3,
    matches: {},
    bets: {},
    users: {},
    programs: {},
    boosts: {},
    pending: {},
    archives: [],
  };
}

function migrate(s) {
  need(
    s &&
      s.matches &&
      s.bets &&
      s.users &&
      (!s.schema || s.schema === 3),
    'Formato de cópia de segurança desconhecido. Não apagues o ficheiro db.json.',
  );

  s.schema = 3;
  s.programs ||= {};
  s.boosts ||= {};
  s.pending ||= {};
  s.archives ||= [];

  for (const m of Object.values(s.matches)) {
    need(
      Number.isFinite(closeAt(m)),
      `Data de fecho inválida no jogo ${m.id}.`,
    );

    m.result =
      m.result == null
        ? null
        : Array.isArray(m.result)
          ? m.result
          : [m.result];

    m.publishAt ??= m.messageId ? 0 : Date.now();
    m.date ||= sportDay(closeAt(m));
    m.revision ||= 1;
    m.version ||= 1;
    m.description ||= '';
    m.roleId ||= null;
    m.imageUrl ||= '';
    m.dirty = true;
    m.published ||= Boolean(m.messageId);
    m.imageFile ||= '';

    for (const [id, b] of Object.entries(s.bets[m.id] || {})) {
      b.revision ||= m.revision;

      if (b.boosted) {
        const key = b.boostDay || m.date;
        s.boosts[key] ||= {};
        s.boosts[key][id] ||= m.id;
      }
    }
  }

  for (const p of Object.values(s.programs)) {
    if (!p.blocks) {
      p.blocks = Object.fromEntries(
        Object.keys(GROUPS).map(key => [key, '']),
      );

      const selected = Object.values(s.matches)
        .filter(
          m =>
            m.status !== 'deleted' &&
            m.channelId === (p.matchesChannelId || p.channelId) &&
            m.date >= p.start &&
            m.date <= p.end,
        )
        .sort((a, b) => closeAt(a) - closeAt(b));

      for (const m of selected) {
        const weekday = new Date(
          m.date + 'T12:00:00Z',
        ).getUTCDay();

        const key =
          ({ 2: 'mardi', 3: 'mercredi', 4: 'jeudi' })[weekday] ||
          'weekend';

        p.blocks[key] +=
          (p.blocks[key] ? ' / ' : '') + m.title;
      }
    }

    p.version ||= 1;
    p.dirty = true;
  }

  return s;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });

    try {
      this.state = migrate(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = initial();
    }

    await this.write(this.state);
  }

  async write(s) {
    const h = await fs.open(this.file + '.tmp', 'w', 0o600);

    try {
      await h.writeFile(JSON.stringify(s));
      await h.sync();
    } finally {
      await h.close();
    }

    try {
      await fs.copyFile(this.file, this.file + '.bak');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    await fs.rename(this.file + '.tmp', this.file);
  }

  async read() {
    await this.queue;
    return copy(this.state);
  }

  change(fn) {
    const task = this.queue.then(async () => {
      const next = copy(this.state);
      const r = await fn(next);
      await this.write(next);
      this.state = next;
      return copy(r);
    });

    this.queue = task.catch(() => {});
    return task;
  }
}

function earned(m, b) {
  return (
    m.status !== 'deleted' &&
    b.revision === m.revision &&
    m.result?.includes(b.choice)
  )
    ? BASE[b.choice] * (b.boosted ? 2 : 1)
    : 0;
}

function rank(s, range = {}) {
  const users = new Map();

  for (const m of Object.values(s.matches)) {
    if (
      m.status === 'deleted' ||
      (range.start && m.date < range.start) ||
      (range.end && m.date > range.end)
    ) {
      continue;
    }

    for (const [id, b] of Object.entries(s.bets[m.id] || {})) {
      if (b.revision !== m.revision) continue;

      const r = users.get(id) || {
        id,
        name: s.users[id]?.username || b.username || id,
        points: 0,
        first: Infinity,
      };

      r.points += earned(m, b);
      r.first = Math.min(r.first, b.placedAt || Infinity);
      users.set(id, r);
    }
  }

  return [...users.values()]
    .filter(r => r.points > 0)
    .sort(
      (a, b) =>
        b.points - a.points ||
        a.first - b.first ||
        a.id.localeCompare(b.id),
    );
}

function boostAvailable(s, userId, now = Date.now()) {
  const key = sportDay(now);

  return (
    !s.boosts[key]?.[userId] &&
    s.users[userId]?.boostUsedToday !== key
  );
}

function place(
  s,
  mid,
  userId,
  choice,
  boost,
  revision,
  username,
  now = Date.now(),
) {
  const m = getMatch(s, mid);

  need(isOpen(m, now), 'As participações estão encerradas.');

  need(
    m.revision === revision && BASE[choice],
    'Esta opção foi alterada. Volta à mensagem do jogo.',
  );

  need(
    !s.bets[mid]?.[userId],
    'Já participaste. O teu palpite não pode ser alterado.',
  );

  need(
    !boost || boostAvailable(s, userId, now),
    'Já utilizaste o teu boost nesta jornada.',
  );

  const key = sportDay(now);

  s.bets[mid] ||= {};
  s.users[userId] ||= { totalPoints: 0 };

  s.bets[mid][userId] = {
    choice,
    boosted: boost,
    revision,
    username,
    placedAt: now,
    boostDay: boost ? key : null,
    points: null,
  };

  Object.assign(s.users[userId], {
    username,
    firstBetAt: s.users[userId].firstBetAt || now,
  });

  if (boost) {
    s.boosts[key] ||= {};
    s.boosts[key][userId] = mid;
    s.users[userId].boostUsedToday = key;
  }
}

function result(s, mid, winners) {
  const m = getMatch(s, mid);

  m.result = winners;
  m.status = 'closed';
  m.dirty = true;
  m.version++;

  for (const b of Object.values(s.bets[mid] || {})) {
    b.points = earned(m, b);
  }

  for (const u of Object.values(s.users)) {
    u.totalPoints = 0;
  }

  for (const r of rank(s)) {
    if (s.users[r.id]) {
      s.users[r.id].totalPoints = r.points;
    }
  }
}

function rangeOptions(o) {
  const start = o.getString('debut');
  const end = o.getString('fin');

  if (start || end) {
    need(start && end, 'Preenche os campos debut E fin.');

    dateKey(start);
    dateKey(end);

    need(start <= end, 'Período inválido.');

    return {
      start,
      end,
      label: `de ${start} a ${end}`,
    };
  }

  const type = o.getString('type') || 'week';

  if (type === 'general') {
    return { label: 'geral' };
  }

  if (type === 'today') {
    const d = sportDay();
    return { start: d, end: d, label: `de ${d}` };
  }

  const d = monday(day(Date.now()));

  return {
    start: d,
    end: shift(d, 6),
    label: `de ${d} a ${shift(d, 6)}`,
  };
}

function embed(title) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setFooter({ text: 'Betclic MatchDay' });
}

const button = (
  id,
  label,
  style = ButtonStyle.Secondary,
  disabled = false,
) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled);

const row = (...buttons) =>
  new ActionRowBuilder().addComponents(buttons);

function media(x, e) {
  if (x.imageFile) {
    const name = path.basename(x.imageFile);
    e.setImage(`attachment://${name}`);

    return {
      files: [new AttachmentBuilder(x.imageFile, { name })],
    };
  }

  if (x.imageUrl) e.setImage(x.imageUrl);
  return {};
}

function longText(e, intro, suffix) {
  e.setDescription(suffix || null);

  const budget = Math.min(
    4096 - suffix.length,
    6000 - e.length,
  );

  let content = '';
  let rest = intro;

  if (intro.length > budget) {
    const required = intro.length - budget;

    need(
      required <= 1900,
      'A mensagem é demasiado longa para o Discord: encurta o texto ou as restantes informações.',
    );

    const paragraph = intro.lastIndexOf('\n', 1900);
    let cut = paragraph >= required ? paragraph : 1900;

    if (/^[\uDC00-\uDFFF]$/.test(intro[cut] || '')) cut--;
    if (intro[cut - 1] === '\\') cut--;

    content = intro.slice(0, cut);
    rest = intro.slice(cut);
  }

  need(
    rest.length <= budget,
    'A mensagem formatada é demasiado longa: encurta ligeiramente o texto.',
  );

  e.setDescription(rest + suffix);
  return content;
}

function matchCard(m) {
  const open = isOpen(m);
  const e = embed(m.title).setColor(open ? COLOR : 0x7F1D1D);

  const intro = m.description
    ? m.description
    : 'Escolhe o teu palpite e tenta chegar ao topo da classificação!';

  const lines = [
    '',
    '',
    `🕒 **Fim das participações: ${time(closeAt(m))}**`,
    '',
  ];

  for (const n of [1, 2, 3]) {
    lines.push(
      `${EMOJIS[n]} **${safe(m['choice' + n + 'Label'])}**`,
      `*Odd: ${safe(m['choice' + n + 'Odds'])}* · ${ICON} **${BASE[n]} ${UNIT}**`,
      '',
    );
  }

  lines.push(
    '⚡ Um boost por jornada para duplicar os pontos que ganhares.',
    'Depois de confirmado, o teu palpite é definitivo.',
  );

  if (!open) {
    lines.push(
      '',
      m.result
        ? '🔒 Resultados registados.'
        : '🔒 As participações estão encerradas.',
    );
  }

  e.setFooter({
    text: `Betclic MatchDay | Match ${m.id}`,
  });

  const content = longText(e, intro, lines.join('\n'));

  return {
    content,
    embeds: [e],
    ...media(m, e),
    components: [
      row(
        ...[1, 2, 3].map(n =>
          button(
            `md:bet:${m.id}:${n}:${m.revision}`,
            `${EMOJIS[n]} ${NAMES[n]} (+${BASE[n]} ${UNIT})`,
            [
              0,
              ButtonStyle.Secondary,
              ButtonStyle.Primary,
              ButtonStyle.Danger,
            ][n],
            !open,
          ),
        ),
        button(`md:my:${m.id}`, '📋 A minha escolha'),
      ),
    ],
    allowedMentions: quiet,
  };
}

function myCard(s, m, userId) {
  const b = s.bets[m.id]?.[userId];

  if (!b) {
    return {
      content: 'Ainda não confirmaste nenhum palpite neste jogo.',
      embeds: [],
      components: [],
    };
  }

  const e = embed('✅ O teu palpite foi registado')
    .setColor(0x22C55E)
    .setDescription(
      [
        `**${safe(m.title)}**`,
        '',
        `${EMOJIS[b.choice]} **${safe(m['choice' + b.choice + 'Label'])}**`,
        '',
        `${ICON} **${BASE[b.choice] * (b.boosted ? 2 : 1)} ${UNIT}** se a tua escolha for vencedora.${b.boosted ? ' Boost x2 ativado.' : ''}`,
        '',
        'A tua escolha é definitiva.',
        m.result
          ? `\nResultado: **${earned(m, b)} ${UNIT} ganhos**.`
          : '',
      ].join('\n'),
    );

  return {
    content: '',
    embeds: [e],
    components: [],
    allowedMentions: quiet,
  };
}

function weekMatches(s, p) {
  return programBlocks(p).flatMap(([key]) =>
    fixtures(p.blocks[key]).map(title => ({
      title,
      group: key,
    })),
  );
}

function weekCard(s, p) {
  const groups = programBlocks(p);
  const custom = Boolean(String(p.description || '').trim());

  const intro = custom
    ? p.description
    : EDITION.description;

  const e = embed(p.title);

  for (const [key, label] of custom ? [] : groups) {
    const date =
      key === 'weekend'
        ? ''
        : (() => {
            const target = {
              mardi: 2,
              mercredi: 3,
              jeudi: 4,
            }[key];

            for (
              let d = p.start;
              d <= p.end;
              d = shift(d, 1)
            ) {
              if (
                new Date(d + 'T12:00:00Z').getUTCDay() === target
              ) {
                return ' ' + d.slice(8) + '/' + d.slice(5, 7);
              }
            }

            return '';
          })();

    const chunks = [];
    let chunk = '';

    for (const fixture of fixtures(p.blocks[key])) {
      const line = '• ' + safe(fixture);

      if (chunk && chunk.length + line.length + 1 > 1024) {
        chunks.push(chunk);
        chunk = '';
      }

      chunk += (chunk ? '\n' : '') + line;
    }

    if (chunk) chunks.push(chunk);

    chunks.forEach((value, n) =>
      e.addFields({
        name: label + date + (n ? ' (continuação)' : ''),
        value: value + '\n\u200b',
        inline: false,
      }),
    );
  }

  if (!custom && p.rulesChannelId) {
    e.addFields({
      name: '📋 Regulamento',
      value: `<#${p.rulesChannelId}>`,
    });
  }

  const disclaimer = /f(?:r)?eebets?/i.test(intro)
    ? ' | Feebets = créditos de jogo não levantáveis'
    : '';

  e.setFooter({
    text: `Betclic MatchDay | Programme ${p.id}${disclaimer}`,
  });

  const content = longText(e, intro, '');

  return {
    content,
    embeds: [e],
    ...media(p, e),
    components: [],
    allowedMentions: quiet,
  };
}

function staffCard(item, kind) {
  const fields = [
    {
      name: 'ID',
      value: `\`${item.id}\``,
    },
    {
      name: 'Estado',
      value: item.status,
      inline: true,
    },
    {
      name: 'Canal',
      value: `<#${item.channelId}>`,
      inline: true,
    },
    {
      name: 'Publicação',
      value: item.publishAt
        ? time(item.publishAt)
        : 'Imediata',
    },
  ];

  if (kind === 'matches') {
    fields.push(
      {
        name: 'Fim das participações',
        value: time(closeAt(item)),
        inline: true,
      },
      {
        name: 'Jornada desportiva',
        value: item.date,
        inline: true,
      },
    );

    for (const n of [1, 2, 3]) {
      fields.push({
        name: `${EMOJIS[n]} Opção ${n} · ${BASE[n]} ${UNIT}`,
        value: `${safe(item[`choice${n}Label`])}\nOdd: **${safe(item[`choice${n}Odds`])}**`,
      });
    }

    const text =
      item.description ||
      'Escolhe o teu palpite e tenta chegar ao topo da classificação!';

    fields.push(
      {
        name: 'Texto do jogo',
        value:
          safe(text.slice(0, 850)) +
          (text.length > 850
            ? '\n[Continuação na mensagem do jogo]'
            : ''),
      },
      {
        name: 'Notificação',
        value: item.roleId
          ? `<@&${item.roleId}>`
          : 'Nenhuma',
        inline: true,
      },
      {
        name: 'Imagem',
        value: item.imageUrl
          ? `[Ver a imagem](${item.imageUrl})`
          : 'Nenhum',
        inline: true,
      },
      {
        name: 'Resultado',
        value:
          item.result === null
            ? 'Pendente'
            : item.result.length
              ? item.result.map(n => `Opção ${n}`).join(', ')
              : 'Nenhuma opção vencedora',
      },
      {
        name: 'Editar este jogo',
        value: `Utiliza **/edit-match** com match_id: \`${item.id}\`\nPodes editar o texto, o título, a imagem e os parâmetros disponíveis. As opções, odds e jornada ficam bloqueadas após a primeira participação.`,
      },
    );
  } else {
    fields.push(
      {
        name: 'Semana',
        value: `${item.start} a ${item.end}`,
      },
      {
        name: 'Canal dos jogos',
        value: `<#${item.matchesChannelId || item.channelId}>`,
      },
    );
  }

  return {
    embeds: [
      embed(item.title)
        .addFields(fields)
        .setFooter({
          text: `Betclic MatchDay | Staff ${kind} ${item.id}`,
        }),
    ],
    allowedMentions: quiet,
  };
}

function rankCard(s, r, page = 0) {
  const all = rank(s, r);
  const pages = Math.max(1, Math.ceil(all.length / 20));

  page = Math.max(
    0,
    Math.min(Number(page) || 0, pages - 1),
  );

  const pending = Object.values(s.matches).filter(
    m =>
      m.status !== 'deleted' &&
      (!r.start || m.date >= r.start) &&
      (!r.end || m.date <= r.end) &&
      m.result === null,
  ).length;

  const e = embed(`🏆 Classificação ${r.label}`)
    .setDescription(
      all
        .slice(page * 20, page * 20 + 20)
        .map(
          (u, n) =>
            `${['🥇', '🥈', '🥉'][page * 20 + n] || `**${page * 20 + n + 1}.**`} <@${u.id}> | ${ICON} **${u.points} ${UNIT}**`,
        )
        .join('\n') || 'Ainda não há pontos.',
    )
    .setFooter({
      text: `Betclic MatchDay | Página ${page + 1}/${pages}`,
    });

  if (pending) {
    e.addFields({
      name: '⏳ Classificação provisória',
      value: `${pending} resultado(s) pendente(s) neste período.`,
    });
  }

  e.addFields({
    name: 'Em caso de empate',
    value:
      'Em caso de empate, fica à frente quem participou primeiro no período.',
  });

  return {
    content: '',
    embeds: [e],
    components:
      pages > 1
        ? [
            row(
              button(
                `md:rank:${r.start || 'all'}:${r.end || 'all'}:${page - 1}`,
                '←',
                2,
                page === 0,
              ),
              button(
                `md:rank:${r.start || 'all'}:${r.end || 'all'}:${page + 1}`,
                '→',
                2,
                page === pages - 1,
              ),
            ),
          ]
        : [],
    allowedMentions: quiet,
  };
}

function matchOptions(c, editing = false) {
  if (editing) {
    c.addStringOption(o =>
      o
        .setName('match_id')
        .setDescription('ID no canal da equipa ou em /list-matches')
        .setRequired(true),
    );
  }

  c
    .addStringOption(o =>
      o
        .setName('titre')
        .setDescription('Título livre do MatchDay')
        .setMaxLength(180)
        .setRequired(!editing),
    )
    .addStringOption(o =>
      o
        .setName('fermeture')
        .setDescription(
          'Fim das participações: AAAA-MM-DD HH:mm, fuso horário configurado',
        )
        .setRequired(!editing),
    );

  for (const n of [1, 2, 3]) {
    c
      .addStringOption(o =>
        o
          .setName(`choix${n}_label`)
          .setDescription(`Opção ${n}: ${BASE[n]} pontos`)
          .setMaxLength(180)
          .setRequired(!editing),
      )
      .addStringOption(o =>
        o
          .setName(`choix${n}_cote`)
          .setDescription(`Odd indicativa da opção ${n}`)
          .setMaxLength(20)
          .setRequired(!editing),
      );
  }

  c
    .addStringOption(o =>
      o
        .setName('publication')
        .setDescription(
          'AAAA-MM-DD HH:mm; publicação imediata se não preencheres',
        ),
    )
    .addChannelOption(o =>
      o
        .setName('channel')
        .setDescription(
          'Canal de destino; canal atual se não preencheres',
        )
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    )
    .addStringOption(o =>
      o
        .setName('journee')
        .setDescription(
          'Jornada AAAA-MM-DD; por defeito, calculada a partir do início do jogo',
        ),
    )
    .addStringOption(o =>
      o
        .setName('texte')
        .setDescription(
          'Apresentação opcional, até 5 000 caracteres',
        )
        .setMaxLength(5000),
    )
    .addStringOption(o =>
      o
        .setName('image')
        .setDescription('URL da imagem, opcional')
        .setMaxLength(1000),
    )
    .addRoleOption(o =>
      o
        .setName('notification')
        .setDescription(
          'Cargo a mencionar na publicação, opcional',
        ),
    );

  if (editing) {
    c
      .addBooleanOption(o =>
        o
          .setName('retirer_image')
          .setDescription('Remover a imagem'),
      )
      .addBooleanOption(o =>
        o
          .setName('retirer_notification')
          .setDescription('Remover a notificação'),
      )
      .addBooleanOption(o =>
        o
          .setName('retirer_texte')
          .setDescription('Repor o texto predefinido'),
      );
  }

  return c;
}

function programOptions(c, editing = false) {
  if (editing) {
    c.addStringOption(o =>
      o
        .setName('programme_id')
        .setDescription('ID do programa no canal da equipa')
        .setRequired(true),
    );
  }

  c
    .addChannelOption(o =>
      o
        .setName('channel')
        .setDescription(
          'Canal do anúncio; canal atual se não preencheres',
        )
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    )
    .addStringOption(o =>
      o
        .setName('publication')
        .setDescription(
          'AAAA-MM-DD HH:mm, fuso TIMEZONE; imediato se não preencheres',
        ),
    )
    .addChannelOption(o =>
      o
        .setName('salon_matchs')
        .setDescription(
          'Canal onde os membros participam nos MatchDays',
        )
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    )
    .addStringOption(o =>
      o
        .setName('image')
        .setDescription('Ligação da imagem do anúncio')
        .setMaxLength(1000),
    )
    .addStringOption(o =>
      o
        .setName('titre')
        .setDescription(
          'Título do anúncio; BETCLIC MATCHDAY se não preencheres',
        )
        .setMaxLength(180),
    )
    .addStringOption(o =>
      o
        .setName('texte')
        .setDescription(
          'Introdução personalizada, até 5 000 caracteres',
        )
        .setMaxLength(5000),
    )
    .addStringOption(o =>
      o
        .setName('debut')
        .setDescription(
          'Início AAAA-MM-DD; por defeito, segunda-feira da semana atual',
        ),
    )
    .addStringOption(o =>
      o
        .setName('fin')
        .setDescription(
          'Fim AAAA-MM-DD; por defeito, domingo da semana atual',
        ),
    );

  for (const key of Object.keys(GROUPS)) {
    c.addStringOption(o =>
      o
        .setName(key)
        .setDescription(
          `Jogos: ${GROUPS[key]}, separados por /; escreve nenhum para remover`,
        )
        .setMaxLength(450),
    );
  }

  c
    .addRoleOption(o =>
      o
        .setName('notification')
        .setDescription(
          'Cargo a mencionar na publicação, opcional',
        ),
    )
    .addChannelOption(o =>
      o
        .setName('reglement')
        .setDescription('Canal do regulamento, opcional')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    );

  if (editing) {
    c
      .addBooleanOption(o =>
        o
          .setName('retirer_image')
          .setDescription('Remover a imagem'),
      )
      .addBooleanOption(o =>
        o
          .setName('retirer_notification')
          .setDescription('Remover a notificação'),
      )
      .addBooleanOption(o =>
        o
          .setName('retirer_texte')
          .setDescription('Repor o texto predefinido'),
      );
  }

  return c;
}

function ranges(c) {
  return c
    .addStringOption(o =>
      o
        .setName('type')
        .setDescription('Semana atual por defeito')
        .addChoices(
          { name: 'Semana', value: 'week' },
          { name: 'Jornada desportiva', value: 'today' },
          { name: 'Geral', value: 'general' },
        ),
    )
    .addStringOption(o =>
      o
        .setName('debut')
        .setDescription('Início personalizado: AAAA-MM-DD'),
    )
    .addStringOption(o =>
      o
        .setName('fin')
        .setDescription('Fim personalizado: AAAA-MM-DD'),
    );
}

const adminCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(P.Administrator);

const idOption = (c, name = 'match_id') =>
  c.addStringOption(o =>
    o
      .setName(name)
      .setDescription('ID na ficha da equipa')
      .setRequired(true),
  );

const commands = [
  matchOptions(
    adminCommand(
      'create-match',
      'Criar um MatchDay imediato ou agendado',
    ),
  ),

  matchOptions(
    adminCommand('edit-match', 'Editar um MatchDay'),
    true,
  ),

  idOption(
    adminCommand(
      'close-match',
      'Encerrar imediatamente as participações',
    ),
  ),

  idOption(
    adminCommand(
      'delete-match',
      'Eliminar um MatchDay com confirmação',
    ),
  ),

  idOption(
    adminCommand(
      'set-result',
      'Registar ou corrigir as opções vencedoras',
    ),
  )
    .addBooleanOption(o =>
      o
        .setName('choix1')
        .setDescription('A opção 1 é vencedora'),
    )
    .addBooleanOption(o =>
      o
        .setName('choix2')
        .setDescription('A opção 2 é vencedora'),
    )
    .addBooleanOption(o =>
      o
        .setName('choix3')
        .setDescription('A opção 3 é vencedora'),
    )
    .addBooleanOption(o =>
      o
        .setName('annule')
        .setDescription('Anular o jogo: sem pontos'),
    ),

  programOptions(
    adminCommand(
      'schedule-week',
      'Criar o anúncio do programa da semana',
    ),
  ),

  programOptions(
    adminCommand(
      'edit-week',
      'Editar o anúncio da semana',
    ),
    true,
  ),

  idOption(
    adminCommand(
      'delete-week',
      'Eliminar um programa com confirmação',
    ),
    'programme_id',
  ),

  ranges(
    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Mostrar a classificação a pedido'),
  ).addBooleanOption(o =>
    o
      .setName('prive')
      .setDescription('Mostrar apenas para ti'),
  ),

  adminCommand(
    'list-matches',
    'Listar os MatchDays e os programas',
  ).addStringOption(o =>
    o
      .setName('semaine')
      .setDescription(
        'Filtrar por uma data AAAA-MM-DD da semana',
      ),
  ),

  ranges(
    adminCommand(
      'export',
      'Exportar os palpites e a classificação em CSV',
    ),
  ),

  adminCommand(
    'reset-scores',
    'Arquivar e repor todos os jogos e pontos a zero, com confirmação',
  ),

  adminCommand(
    'diagnostic',
    'Verificar os dados guardados e os agendamentos',
  ),
];

async function cacheImage(x, dir) {
  x.imageFile = '';

  if (!x.imageUrl) return;

  const u = new URL(x.imageUrl);

  if (
    !['cdn.discordapp.com', 'media.discordapp.net']
      .includes(u.hostname)
  ) {
    return;
  }

  const r = await fetch(u, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  need(
    r.ok,
    'Ligação Discord expirada ou inacessível. Copia novamente a ligação da imagem.',
  );

  const ext = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[r.headers.get('content-type')?.split(';')[0]];

  need(
    ext,
    'Formatos de imagem: PNG, JPG, WEBP ou GIF.',
  );

  need(
    Number(r.headers.get('content-length') || 0) <=
      8 * 1024 * 1024,
    'Imagem demasiado grande: máximo de 8 MB.',
  );

  const chunks = [];
  let size = 0;

  for await (const c of r.body) {
    size += c.length;

    need(
      size <= 8 * 1024 * 1024,
      'Imagem demasiado grande: máximo de 8 MB.',
    );

    chunks.push(c);
  }

  const buffer = Buffer.concat(chunks);
  const folder = path.join(dir, 'images');

  await fs.mkdir(folder, { recursive: true });

  x.imageFile = path.join(
    folder,
    `${x.id}-${createHash('sha256')
      .update(buffer)
      .digest('hex')
      .slice(0, 12)}${ext}`,
  );

  await fs.writeFile(x.imageFile, buffer, {
    mode: 0o600,
  });
}

async function run() {
  const env = process.env;

  const guildId = env.DISCORD_GUILD_ID?.trim();
  const staffId = env.DISCORD_ADMIN_CHANNEL_ID?.trim();

  need(
    env.DISCORD_TOKEN &&
      /^\d{17,20}$/.test(guildId || ''),
    'Preenche DISCORD_TOKEN e DISCORD_GUILD_ID.',
  );

  need(
    !staffId || /^\d{17,20}$/.test(staffId),
    'DISCORD_ADMIN_CHANNEL_ID inválido.',
  );

  parts(Date.now());

  const dir =
    env.DATA_DIR ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    './data';

  if (env.RAILWAY_ENVIRONMENT_ID) {
    need(
      env.RAILWAY_VOLUME_MOUNT_PATH &&
        path.resolve(dir) ===
          path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH),
      'Liga o volume e configura DATA_DIR com o mesmo caminho.',
    );
  }

  const store = new Store(dir);
  await store.init();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  let ticking = false;
  let stopping = false;
  let timer;

  const admin = i =>
    need(
      i.memberPermissions?.has(P.Administrator),
      'Este comando está reservado aos administradores.',
    );

  const log = (label, e) => {
    const message = String(
      e?.message || 'Erro sem detalhes',
    ).replaceAll(env.DISCORD_TOKEN, '[TOKEN OCULTO]');

    console.error(
      `${label}: ${e?.code || e?.name || 'Erro'} | ${message.slice(0, 1500)}`,
    );
  };

  async function channel(id) {
    const c = await client.channels.fetch(id);

    need(
      c &&
        c.guildId === guildId &&
        [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ].includes(c.type),
      'Canal inacessível ou pertencente a outro servidor.',
    );

    need(
      c.permissionsFor(client.user)?.has([
        P.ViewChannel,
        P.SendMessages,
        P.EmbedLinks,
        P.AttachFiles,
        P.ReadMessageHistory,
      ]),
      'O bot precisa de permissões para ver o canal, enviar mensagens, incorporar ligações, anexar ficheiros e ler o histórico.',
    );

    return c;
  }

  async function fetchMessage(c, id) {
    try {
      return await c.messages.fetch(id);
    } catch (e) {
      if (e.code !== 10008) throw e;
      return null;
    }
  }

  async function findMessage(c, marker, since) {
    if (!since) return null;

    let before;

    for (let n = 0; n < 100; n++) {
      const list = await c.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!list.size) return null;

      const found = list.find(
        m =>
          m.author.id === client.user.id &&
          m.embeds.some(e =>
            e.footer?.text?.startsWith(marker),
          ),
      );

      if (found) return found;

      const last = list.last();

      if (last.createdTimestamp < since - 10000) {
        return null;
      }

      before = last.id;
    }

    throw new Error(
      'Histórico demasiado longo para verificar um envio interrompido.',
    );
  }

  async function syncStaff(x, kind) {
    if (!staffId || x.status === 'deleted') return;

    if (
      kind === 'matches' &&
      !x.staffMessageId &&
      (
        x.status === 'closed' ||
        closeAt(x) <= Date.now()
      )
    ) {
      return;
    }

    const payload = staffCard(x, kind);

    const hash = digest(
      payload.embeds.map(e => e.toJSON()),
    );

    if (
      x.staffHash === hash &&
      x.staffChannelId === staffId
    ) {
      return;
    }

    const c = await channel(staffId);

    let previous =
      x.staffChannelId === staffId && x.staffMessageId
        ? await fetchMessage(c, x.staffMessageId)
        : null;

    if (!previous && x.staffMessageId) return;

    if (!previous && x.staffSendingAt) {
      previous = await findMessage(
        c,
        `Betclic MatchDay | Staff ${kind} ${x.id}`,
        x.staffSendingAt,
      );
    }

    if (!previous && !x.staffSendingAt) {
      await store.change(s => {
        s[kind][x.id].staffSendingAt = Date.now();
      });
    }

    const message = previous
      ? await previous.edit(payload)
      : await c.send({
          ...payload,
          nonce: BigInt(
            '0x' +
              digest(`staff:${kind}:${x.id}`).slice(0, 16),
          ).toString(),
          enforceNonce: true,
        });

    await store.change(s => {
      Object.assign(s[kind][x.id], {
        staffMessageId: message.id,
        staffChannelId: staffId,
        staffHash: hash,
      });
    });
  }

  async function publish(x, kind, s) {
    const isWeek = kind === 'programs';

    if (x.status === 'deleted') {
      if (x.messageId) {
        const c = await channel(
          x.postChannelId || x.channelId,
        );

        const msg = await fetchMessage(c, x.messageId);

        if (msg) await msg.delete();

        await store.change(db => {
          db[kind][x.id].messageId = null;
        });
      }

      return;
    }

    if (!x.published && x.publishAt > Date.now()) {
      return;
    }

    if (
      !isWeek &&
      !x.published &&
      closeAt(x) <= Date.now()
    ) {
      if (!x.missed) {
        await store.change(db => {
          db.matches[x.id].missed = true;
          db.matches[x.id].status = 'closed';
          db.matches[x.id].version++;
        });

        log(
          `Publicação falhada ${x.id}`,
          new Error('O jogo já começou. Não foi publicado.'),
        );
      }

      return;
    }

    const payload = isWeek
      ? weekCard(s, x)
      : matchCard({
          ...x,
          status:
            x.status === 'scheduled'
              ? 'open'
              : x.status,
        });

    const hash = digest({
      content: payload.content || '',
      embeds: payload.embeds.map(e => e.toJSON()),
      components: payload.components.map(r => r.toJSON()),
      image: x.imageUrl,
      file: x.imageFile,
    });

    if (
      x.published &&
      x.publicHash === hash &&
      !x.dirty
    ) {
      return;
    }

    const moving = Boolean(
      x.messageId &&
        x.postChannelId &&
        x.postChannelId !== x.channelId,
    );

    if (moving) {
      const oldC = await channel(x.postChannelId);
      const old = await fetchMessage(oldC, x.messageId);

      if (old) await old.delete();

      await store.change(db => {
        const e = db[kind][x.id];
        e.messageId = null;
        e.sendingAt = null;
      });

      x.messageId = null;
      x.sendingAt = null;
    }

    const c = await channel(x.channelId);

    let previous = x.messageId
      ? await fetchMessage(c, x.messageId)
      : null;

    if (x.published && !previous && !moving) {
      await store.change(db => {
        const latest = db[kind][x.id];

        if (latest.version === x.version) {
          latest.publicHash = hash;
          latest.dirty = false;
        }
      });

      return;
    }

    if (!previous && !x.messageId && x.sendingAt) {
      previous = await findMessage(
        c,
        isWeek
          ? `Betclic MatchDay | Programme ${x.id} |`
          : `Betclic MatchDay | Match ${x.id}`,
        x.sendingAt,
      );
    }

    if (!previous && !x.sendingAt) {
      x.sendingAt = Date.now();

      await store.change(db => {
        db[kind][x.id].sendingAt = x.sendingAt;
      });
    }

    const notify = !x.published && x.roleId;

    const message = previous
      ? await previous.edit({
          ...payload,
          attachments: [],
          content: payload.content || '',
          allowedMentions: quiet,
        })
      : await c.send({
          ...payload,
          content: [
            notify ? `<@&${x.roleId}>` : '',
            payload.content || '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          allowedMentions: notify
            ? { parse: [], roles: [x.roleId] }
            : quiet,
          nonce: BigInt(
            '0x' +
              digest(
                `${kind}:${x.id}:${x.sendingAt}`,
              ).slice(0, 16),
          ).toString(),
          enforceNonce: true,
        });

    const remove = await store.change(db => {
      const latest = db[kind][x.id];

      latest.messageId = message.id;
      latest.postChannelId = x.channelId;

      if (latest.status === 'deleted') return true;

      latest.published = true;

      if (latest.version === x.version) {
        latest.publicHash = hash;
        latest.dirty = false;

        if (latest.status === 'scheduled') {
          latest.status = 'open';
        }
      }

      return false;
    });

    if (remove) {
      await message.delete();

      await store.change(db => {
        db[kind][x.id].messageId = null;
      });
    }
  }

  async function tick() {
    if (ticking || stopping || !client.isReady()) {
      return;
    }

    ticking = true;

    try {
      const current = await store.read();

      if (
        Object.values(current.matches).some(
          m =>
            m.status === 'open' &&
            closeAt(m) <= Date.now(),
        )
      ) {
        await store.change(s => {
          for (const m of Object.values(s.matches)) {
            if (
              m.status === 'open' &&
              closeAt(m) <= Date.now()
            ) {
              m.status = 'closed';
              m.dirty = true;
              m.version++;
            }
          }
        });
      }

      const s = await store.read();

      for (const kind of ['programs', 'matches']) {
        const sorted = Object.values(s[kind])
          .sort((a, b) => a.publishAt - b.publishAt);

        for (const x of sorted) {
          try {
            await syncStaff(x, kind);
          } catch (e) {
            log(`Ficha da equipa ${x.id}`, e);
          }

          try {
            await publish(x, kind, s);
          } catch (e) {
            log(`Publication ${x.id}`, e);
          }
        }
      }
    } catch (e) {
      log('Programmation', e);
    } finally {
      ticking = false;
    }
  }

  async function ask(i, data) {
    const token = uid();

    await store.change(s => {
      s.pending[token] = {
        ...data,
        uid: i.user.id,
        expires: Date.now() + 900000,
      };
    });

    const content =
      data.kind === 'reset'
        ? '⚠️ Arquivar todos os jogos, programas, pontos e boosts e recomeçar do zero?'
        : data.table === 'programs'
          ? '⚠️ Eliminar este anúncio? Os jogos e os palpites serão mantidos.'
          : '⚠️ Eliminar este MatchDay? Os seus pontos serão removidos das classificações. Será arquivada uma cópia.';

    return i.editReply({
      content,
      embeds: [],
      components: [
        row(
          button(
            `md:yes:${token}`,
            'Confirmar',
            ButtonStyle.Danger,
          ),
          button(`md:no:${token}`, 'Cancelar'),
        ),
      ],
    });
  }

  async function slash(i) {
    need(
      i.guildId === guildId,
      'Utiliza este comando no servidor configurado.',
    );

    const name = i.commandName;

    if (name !== 'classement') admin(i);

    await i.deferReply({
      flags:
        name === 'classement' &&
        !i.options.getBoolean('prive')
          ? undefined
          : MessageFlags.Ephemeral,
    });

    if (
      name === 'create-match' ||
      name === 'edit-match'
    ) {
      const o = i.options;
      const editing = name === 'edit-match';
      const state = await store.read();

      const old = editing
        ? getMatch(state, o.getString('match_id'))
        : null;

      const m = old
        ? copy(old)
        : {
            id: 'match_' + uid(),
            status: 'scheduled',
            published: false,
            result: null,
            revision: 1,
            version: 1,
            createdAt: Date.now(),
            publishAt: Date.now(),
            imageUrl: '',
            imageFile: '',
            description: '',
            roleId: null,
            messageId: null,
          };

      if (o.getString('titre') !== null) {
        m.title = clean(
          o.getString('titre'),
          180,
          'Título',
        );
      }

      if (o.getString('fermeture')) {
        m.closingTimeUTC = new Date(
          parseTime(o.getString('fermeture')),
        ).toISOString();
      }

      for (const n of [1, 2, 3]) {
        if (o.getString(`choix${n}_label`) !== null) {
          m[`choice${n}Label`] = clean(
            o.getString(`choix${n}_label`),
            180,
            'Opção',
          );
        }

        if (o.getString(`choix${n}_cote`) !== null) {
          m[`choice${n}Odds`] = odds(
            o.getString(`choix${n}_cote`),
          );
        }
      }

      if (o.getString('publication')) {
        need(
          !old?.published,
          'O jogo já foi publicado: o horário de publicação não pode ser alterado.',
        );

        m.publishAt = parseTime(
          o.getString('publication'),
        );
      }

      if (o.getChannel('channel')) {
        m.channelId = o.getChannel('channel').id;
      }

      m.channelId ||= i.channelId;

      m.date = o.getString('journee')
        ? dateKey(o.getString('journee'))
        : old?.date || sportDay(closeAt(m));

      if (o.getString('texte') !== null) {
        m.description = o.getString('texte');
      }

      if (o.getString('image') !== null) {
        m.imageUrl = imageURL(o.getString('image'));
      }

      if (o.getRole('notification')) {
        m.roleId = o.getRole('notification').id;
      }

      if (editing && o.getBoolean('retirer_image')) {
        m.imageUrl = '';
        m.imageFile = '';
      }

      if (
        editing &&
        o.getBoolean('retirer_notification')
      ) {
        m.roleId = null;
      }

      if (editing && o.getBoolean('retirer_texte')) {
        m.description = '';
      }

      need(
        m.publishAt < closeAt(m),
        'A publicação deve ser anterior ao fecho das participações.',
      );

      if (!old?.published) {
        need(
          closeAt(m) > Date.now() &&
            (
              !o.getString('publication') ||
              m.publishAt > Date.now()
            ),
          'Escolhe datas futuras.',
        );
      }

      if (
        old &&
        (
          old.status === 'closed' ||
          closeAt(old) <= Date.now()
        )
      ) {
        need(
          closeAt(m) <= closeAt(old),
          'Um jogo encerrado não pode ser reaberto.',
        );

        m.status = 'closed';
      }

      const changedChoices =
        old &&
        [1, 2, 3].some(
          n =>
            m[`choice${n}Label`] !==
              old[`choice${n}Label`] ||
            m[`choice${n}Odds`] !==
              old[`choice${n}Odds`],
        );

      const sensitive =
        changedChoices ||
        (old && m.date !== old.date);

      matchCard(m);
      await channel(m.channelId);

      if (!old || m.imageUrl !== old.imageUrl) {
        await cacheImage(m, store.dir);
      }

      await store.change(s => {
        if (old) {
          const latest = getMatch(s, m.id);

          need(
            latest.version === old.version,
            'O jogo foi alterado. Tenta novamente.',
          );

          need(
            !sensitive ||
              !Object.keys(s.bets[m.id] || {}).length,
            'Já existem palpites: não podes alterar as opções, as odds ou a jornada.',
          );

          Object.assign(m, {
            published: latest.published,
            status:
              latest.status === 'scheduled' &&
              m.status === 'closed'
                ? 'closed'
                : latest.status,
            messageId: latest.messageId,
            postChannelId: latest.postChannelId,
            sendingAt: latest.sendingAt,
            staffMessageId: latest.staffMessageId,
            staffChannelId: latest.staffChannelId,
            staffSendingAt: latest.staffSendingAt,
          });

          if (sensitive) m.revision++;
        }

        m.version++;
        m.dirty = true;
        s.matches[m.id] = m;
        s.bets[m.id] ||= {};
      });

      void tick();

      return i.editReply(
        `✅ MatchDay ${editing ? 'atualizado' : 'criado'}.\nID : \`${m.id}\`\nPublicação: ${time(m.publishAt)}\nFim das participações: ${time(closeAt(m))}\nJornada desportiva: ${m.date}\nCanal: <#${m.channelId}>`,
      );
    }

    if (
      name === 'schedule-week' ||
      name === 'edit-week'
    ) {
      const o = i.options;
      const editing = name === 'edit-week';
      const s = await store.read();

      const old = editing
        ? s.programs[o.getString('programme_id')]
        : null;

      need(
        !editing ||
          (old && old.status !== 'deleted'),
        'Programa não encontrado.',
      );

      const p = old
        ? copy(old)
        : {
            id: 'week_' + uid(),
            status: 'scheduled',
            published: false,
            version: 1,
            publishAt: Date.now(),
            imageUrl: '',
            imageFile: '',
            description: '',
            customText: false,
            title: EDITION.title,
            start: monday(day(Date.now())),
            end: shift(monday(day(Date.now())), 6),
            blocks: copy(EDITION.blocks),
            roleId: null,
            messageId: null,
          };

      if (o.getString('titre') !== null) {
        p.title = clean(
          o.getString('titre'),
          180,
          'Título',
        );
      }

      if (o.getString('debut')) {
        p.start = dateKey(o.getString('debut'));
      }

      if (o.getString('fin')) {
        p.end = dateKey(o.getString('fin'));
      }

      need(
        Date.parse(p.end + 'T12:00:00Z') -
          Date.parse(p.start + 'T12:00:00Z') <=
          6 * 86400000,
        'O programa não pode ultrapassar sete dias.',
      );

      for (const key of Object.keys(GROUPS)) {
        if (o.getString(key) !== null) {
          const text = o
            .getString(key)
            .trim()
            .replace(/[\u2013\u2014]/g, '-');

          p.blocks[key] =
            /^(?:aucun|nenhum)$/i.test(text)
              ? ''
              : text;
        }
      }

      if (o.getChannel('reglement')) {
        p.rulesChannelId = o.getChannel('reglement').id;
      }

      validateProgram(p);

      if (o.getString('publication')) {
        need(
          !old?.published,
          'O anúncio já foi publicado: edita o conteúdo diretamente com este comando.',
        );

        p.publishAt = parseTime(
          o.getString('publication'),
        );

        need(
          p.publishAt > Date.now(),
          'Escolhe uma publicação futura.',
        );
      }

      if (o.getChannel('channel')) {
        p.channelId = o.getChannel('channel').id;
      }

      p.channelId ||= i.channelId;

      if (o.getChannel('salon_matchs')) {
        p.matchesChannelId =
          o.getChannel('salon_matchs').id;
      }

      p.matchesChannelId ||= p.channelId;

      if (o.getString('texte') !== null) {
        p.description = o.getString('texte');
        p.customText = Boolean(p.description.trim());
      }

      if (o.getString('image') !== null) {
        p.imageUrl = imageURL(o.getString('image'));
      }

      if (o.getRole('notification')) {
        p.roleId = o.getRole('notification').id;
      }

      if (editing && o.getBoolean('retirer_image')) {
        p.imageUrl = '';
        p.imageFile = '';
      }

      if (
        editing &&
        o.getBoolean('retirer_notification')
      ) {
        p.roleId = null;
      }

      if (editing && o.getBoolean('retirer_texte')) {
        p.description = '';
        p.customText = false;
      }

      const preview = weekCard(s, p);

      need(
        preview.embeds[0].length <= 6000,
        'O programa é demasiado longo para o Discord: encurta o texto ou a lista de jogos.',
      );

      await channel(p.channelId);
      await channel(p.matchesChannelId);

      if (!old || p.imageUrl !== old.imageUrl) {
        await cacheImage(p, store.dir);
      }

      await store.change(s => {
        if (old) {
          const latest = s.programs[p.id];

          need(
            latest.version === old.version,
            'O programa foi alterado. Tenta novamente.',
          );

          Object.assign(p, {
            published: latest.published,
            status: latest.status,
            messageId: latest.messageId,
            postChannelId: latest.postChannelId,
            sendingAt: latest.sendingAt,
            staffMessageId: latest.staffMessageId,
            staffChannelId: latest.staffChannelId,
            staffSendingAt: latest.staffSendingAt,
          });
        }

        p.version++;
        p.dirty = true;
        s.programs[p.id] = p;
      });

      void tick();

      return i.editReply(
        `✅ Programa ${editing ? 'atualizado' : 'criado'}.\nID : \`${p.id}\`\nDe ${p.start} a ${p.end}\nPublicação: ${time(p.publishAt)}\nCanal: <#${p.channelId}>\n${programBlocks(p).length} grupos e ${weekMatches(s, p).length} jogos, independentes dos palpites.\nPara editar os jogos: /edit-week.`,
      );
    }

    const s = await store.read();

    if (name === 'close-match') {
      const id = i.options.getString('match_id');

      await store.change(s => {
        const m = getMatch(s, id);

        need(
          m.published,
          'Este jogo está agendado: utiliza /delete-match para cancelar a publicação.',
        );

        m.status = 'closed';
        m.version++;
        m.dirty = true;
      });

      void tick();

      return i.editReply(
        '🔒 Participações encerradas. Os palpites foram mantidos.',
      );
    }

    if (name === 'set-result') {
      const id = i.options.getString('match_id');

      const winners = [1, 2, 3].filter(n =>
        i.options.getBoolean(`choix${n}`),
      );

      need(
        i.options.getBoolean('annule') ||
          winners.length,
        'Seleciona as opções vencedoras ou annule:true se nenhuma opção ganhar.',
      );

      need(
        !i.options.getBoolean('annule') ||
          !winners.length,
        'Um jogo anulado não pode ter uma opção vencedora.',
      );

      await store.change(s => {
        const m = getMatch(s, id);

        need(
          m.published,
          'Este jogo ainda não foi publicado.',
        );

        need(
          Date.now() >= closeAt(m),
          'Espera pelo fecho das participações antes de registar o resultado.',
        );

        result(s, id, winners);
      });

      void tick();

      return i.editReply(
        '✅ Resultado registado. Os pontos são recalculados sem duplicação, mesmo em caso de correção.',
      );
    }

    if (
      name === 'delete-match' ||
      name === 'delete-week'
    ) {
      const table =
        name === 'delete-match'
          ? 'matches'
          : 'programs';

      const id = i.options.getString(
        table === 'matches'
          ? 'match_id'
          : 'programme_id',
      );

      const x = s[table][id];

      need(
        x && x.status !== 'deleted',
        'Elemento não encontrado.',
      );

      return ask(i, {
        kind: 'delete',
        table,
        id,
        version: x.version,
      });
    }

    if (name === 'reset-scores') {
      return ask(i, {
        kind: 'reset',
        fingerprint: digest({
          matches: s.matches,
          bets: s.bets,
          programs: s.programs,
        }),
      });
    }

    if (name === 'classement') {
      return i.editReply(
        rankCard(s, rangeOptions(i.options)),
      );
    }

    if (name === 'list-matches') {
      const date = i.options.getString('semaine');
      const start = date
        ? monday(dateKey(date))
        : null;

      const items = Object.values(s.matches)
        .filter(
          m =>
            m.status !== 'deleted' &&
            (
              !start ||
              (
                m.date >= start &&
                m.date <= shift(start, 6)
              )
            ),
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            closeAt(a) - closeAt(b),
        );

      const lines = items.map(
        m =>
          `${m.date} | ${m.title} | ${m.status}\nID: ${m.id}\nPublicação: ${time(m.publishAt)} | Fecho: ${time(closeAt(m))}\n`,
      );

      lines.push(
        '\nPROGRAMAS\n',
        ...Object.values(s.programs)
          .filter(p => p.status !== 'deleted')
          .map(
            p =>
              `${p.start} a ${p.end} | ${p.title}\nID: ${p.id}\n`,
          ),
      );

      return i.editReply({
        content: `${items.length} MatchDay(s). Os IDs também estão disponíveis no canal da equipa, se estiver configurado.`,
        files: [
          new AttachmentBuilder(
            Buffer.from(
              lines.join('\n') || 'Nenhum jogo',
            ),
            { name: 'matchdays.txt' },
          ),
        ],
      });
    }

    if (name === 'diagnostic') {
      return i.editReply(
        `✅ Dados: ${store.file}\n🕒 Fuso horário: ${TZ}\n⚡ Jornada do boost: do meio-dia ao meio-dia (${TZ})\n📅 ${Object.values(s.matches).filter(m => !m.published && m.status !== 'deleted' && !m.missed).length} jogos por publicar\n📣 ${Object.values(s.programs).filter(p => !p.published && p.status !== 'deleted').length} programas por publicar\n🏆 Sem publicação automática da classificação\n${ICON} Unidade: ${UNIT}`,
      );
    }

    if (name === 'export') {
      const r = rangeOptions(i.options);
      const values = rank(s, r);

      const rows = [
        [
          'match_id',
          'journee',
          'titre',
          'discord_id',
          'pseudo',
          'choix',
          'boost',
          'points',
          'resultat',
        ],
      ];

      for (const m of Object.values(s.matches)) {
        if (
          m.status === 'deleted' ||
          (r.start && m.date < r.start) ||
          (r.end && m.date > r.end)
        ) {
          continue;
        }

        for (
          const [id, b] of Object.entries(
            s.bets[m.id] || {},
          )
        ) {
          if (b.revision === m.revision) {
            rows.push([
              m.id,
              m.date,
              m.title,
              id,
              b.username,
              m[`choice${b.choice}Label`],
              b.boosted ? 'sim' : 'não',
              earned(m, b),
              m.result === null
                ? 'pendente'
                : m.result.join(',') || 'anulado',
            ]);
          }
        }
      }

      const csv = v =>
        `"${String(v ?? '')
          .replaceAll('"', '""')
          .replace(/^[=+\-@]/, "'$&")}"`;

      const file = (rows, name) =>
        new AttachmentBuilder(
          Buffer.from(
            '\uFEFF' +
              rows
                .map(r => r.map(csv).join(';'))
                .join('\r\n'),
          ),
          { name },
        );

      return i.editReply({
        content: `Export ${r.label}`,
        files: [
          file(rows, 'pronostics.csv'),
          file(
            [
              ['rang', 'discord_id', 'pseudo', 'points'],
              ...values.map((u, n) => [
                n + 1,
                u.id,
                u.name,
                u.points,
              ]),
            ],
            'classement.csv',
          ),
        ],
      });
    }
  }

  async function buttons(i) {
    need(
      i.guildId === guildId,
      'Servidor inválido.',
    );

    const privateMessage =
      i.message.flags.has(MessageFlags.Ephemeral);

    if (privateMessage) {
      await i.deferUpdate();
    } else {
      await i.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    }

    let [
      ,
      action,
      mid,
      value,
      revision,
      finalRevision,
    ] = i.customId.split(':');

    if (i.customId.startsWith('bet_')) {
      const a = i.customId.split('_');
      action = 'bet';
      value = a.pop();
      mid = a.slice(1).join('_');
    }

    if (i.customId.startsWith('confirm_')) {
      const a = i.customId.split('_');
      action = 'confirm';
      revision = a.pop();
      value = a.pop();
      mid = a.slice(1).join('_');
    }

    if (i.customId === 'cancel_bet') {
      action = 'cancel';
    }

    if (action === 'cancel') {
      return i.editReply({
        content: 'Escolha cancelada.',
        embeds: [],
        components: [],
      });
    }

    if (action === 'yes' || action === 'no') {
      admin(i);

      await store.change(s => {
        const p = s.pending[mid];

        need(
          p &&
            p.uid === i.user.id &&
            p.expires > Date.now(),
          'Confirmação expirada. Tenta novamente.',
        );

        if (action === 'yes') {
          if (p.kind === 'reset') {
            need(
              p.fingerprint ===
                digest({
                  matches: s.matches,
                  bets: s.bets,
                  programs: s.programs,
                }),
              'Os dados foram alterados. Executa novamente /reset-scores.',
            );

            s.archives.push({
              at: Date.now(),
              kind: 'reset',
              matches: copy(s.matches),
              bets: copy(s.bets),
              users: copy(s.users),
              programs: copy(s.programs),
              boosts: copy(s.boosts),
            });

            for (const table of ['matches', 'programs']) {
              for (const x of Object.values(s[table])) {
                x.status = 'deleted';
                x.version++;
              }
            }

            s.users = {};
            s.bets = {};
            s.boosts = {};
          } else {
            const x = s[p.table][p.id];

            need(
              x && x.version === p.version,
              'Este elemento foi alterado. Tenta novamente.',
            );

            s.archives.push({
              at: Date.now(),
              kind: 'delete',
              table: p.table,
              data: copy(x),
              bets:
                p.table === 'matches'
                  ? copy(s.bets[x.id] || {})
                  : undefined,
            });

            x.status = 'deleted';
            x.version++;
            x.dirty = true;

            for (const u of Object.values(s.users)) {
              u.totalPoints = 0;
            }

            for (const r of rank(s)) {
              if (s.users[r.id]) {
                s.users[r.id].totalPoints = r.points;
              }
            }
          }
        }

        delete s.pending[mid];
      });

      void tick();

      return i.editReply({
        content:
          action === 'yes'
            ? '✅ Operação confirmada.'
            : 'Operação cancelada.',
        embeds: [],
        components: [],
      });
    }

    const s = await store.read();

    if (action === 'week') {
      const p = s.programs[mid];

      need(
        p &&
          p.published &&
          p.status !== 'deleted',
        'Programa indisponível.',
      );

      return i.editReply(weekCard(s, p, value));
    }

    if (action === 'rank') {
      const r =
        mid === 'all'
          ? { label: 'geral' }
          : {
              start: mid,
              end: value,
              label: `de ${mid} a ${value}`,
            };

      return i.editReply(rankCard(s, r, revision));
    }

    const m = getMatch(s, mid);

    if (action === 'my') {
      return i.editReply(myCard(s, m, i.user.id));
    }

    if (s.bets[mid]?.[i.user.id]) {
      return i.editReply({
        content:
          '✅ O teu palpite já foi registado. Para o consultares, clica em « 📋 A minha escolha ».',
        embeds: [],
        components: [],
        allowedMentions: quiet,
      });
    }

    need(
      isOpen(m),
      'As participações estão encerradas.',
    );

    const n = Number(value);

    need(BASE[n], 'Opção inválida.');

    if (action === 'bet') {
      need(
        !revision ||
          Number(revision) === m.revision,
        'O jogo foi alterado. Utiliza a mensagem atualizada.',
      );

      const boost = boostAvailable(s, i.user.id);

      const e = embed('Confirma o teu palpite')
        .setDescription(
          [
            `**${safe(m.title)}**`,
            '',
            `${EMOJIS[n]} **${safe(m['choice' + n + 'Label'])}**`,
            '',
            `${ICON} **${BASE[n]} ${UNIT}** se a tua escolha for vencedora.`,
            '',
            boost
              ? `⚡ Com o boost x2: **${BASE[n] * 2} ${UNIT}**.`
              : 'Já utilizaste o boost desta jornada.',
            '',
            'Depois de confirmado, o teu palpite não pode ser alterado.',
          ].join('\n'),
        );

      const buttons = [
        button(
          `md:confirm:${mid}:${n}:0:${m.revision}`,
          '✅ Confirmar',
          ButtonStyle.Success,
        ),
      ];

      if (boost) {
        buttons.push(
          button(
            `md:confirm:${mid}:${n}:1:${m.revision}`,
            '⚡ Confirmar + Boost x2',
            ButtonStyle.Primary,
          ),
        );
      }

      buttons.push(button('md:cancel', 'Cancelar'));

      return i.editReply({
        content: '',
        embeds: [e],
        components: [row(...buttons)],
      });
    }

    if (action === 'confirm') {
      await store.change(s =>
        place(
          s,
          mid,
          i.user.id,
          n,
          revision === '1',
          Number(finalRevision || m.revision),
          i.user.username,
        ),
      );

      const latest = await store.read();

      return i.editReply(
        myCard(
          latest,
          getMatch(latest, mid),
          i.user.id,
        ),
      );
    }
  }

  client.on(Events.InteractionCreate, async i => {
    if (stopping) return;

    if (
      !(
        i.isChatInputCommand() &&
        commands.some(c => c.name === i.commandName)
      ) &&
      !(
        i.isButton() &&
        /^(md:|bet_|confirm_|cancel_bet$)/.test(i.customId)
      )
    ) {
      return;
    }

    try {
      if (i.isChatInputCommand()) {
        await slash(i);
      } else {
        await buttons(i);
      }
    } catch (e) {
      if (!(e instanceof UserError)) {
        log('Interaction', e);
      }

      const payload = {
        content:
          e instanceof UserError
            ? `⚠️ ${e.message}`
            : 'Ocorreu um erro. Consulta os registos do bot.',
        allowedMentions: quiet,
      };

      try {
        if (i.deferred || i.replied) {
          if (i.isButton() || i.ephemeral) {
            await i.editReply({
              ...payload,
              embeds: [],
              components: [],
            });
          } else {
            await i.followUp({
              ...payload,
              flags: MessageFlags.Ephemeral,
            });
          }
        } else {
          await i.reply({
            ...payload,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        log('Resposta de erro', e);
      }
    }
  });

  client.on(Events.Error, e => log('Discord', e));

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);

      if (staffId) await channel(staffId);

      for (const c of commands) {
        await guild.commands.create(c.toJSON());
      }

      const globals =
        await client.application.commands.fetch();

      for (const c of globals.values()) {
        if (commands.some(x => x.name === c.name)) {
          await client.application.commands.delete(c.id);
        }
      }

      console.log(
        `MatchDay pronto: ${client.user.tag}. Fuso horário: ${TZ}. Dados: ${store.file}.`,
      );

      await tick();

      timer = setInterval(() => void tick(), 15000);
    } catch (e) {
      log('Inicialização', e);
      void stop(1);
    }
  });

  async function stop(code = 0) {
    if (stopping) return;

    stopping = true;
    clearInterval(timer);
    client.destroy();
    await store.queue;
    process.exit(code);
  }

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  process.once('uncaughtException', e => {
    log('Erro fatal', e);
    void stop(1);
  });

  process.once('unhandledRejection', e => {
    log('Erro fatal', e);
    void stop(1);
  });

  await client.login(env.DISCORD_TOKEN);
}

if (
  require.main === module ||
  process.env.MATCHDAY_ENTRYPOINT === 'src'
) {
  run().catch(e => {
    console.error(
      `Arranque: ${e instanceof UserError ? e.message : e.code || e.name}`,
    );

    process.exitCode = 1;
  });
} else {
  module.exports = {
    initial,
    migrate,
    Store,
    parseTime,
    day,
    sportDay,
    monday,
    shift,
    rank,
    earned,
    place,
    result,
    isOpen,
    weekCard,
    weekMatches,
    matchCard,
    commands,
    EDITION,
    programBlocks,
    validateProgram,
  };
}
