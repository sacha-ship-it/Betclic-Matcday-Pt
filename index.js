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

const COLOR = /^#[a-f\d]{6}$/i.test(
  process.env.MATCHDAY_COLOR || ''
)
  ? process.env.MATCHDAY_COLOR
  : '#E10014';

const BASE = { 1: 2, 2: 4, 3: 8 };

const EMOJIS = {
  1: '🤙',
  2: '⚡',
  3: '🔥',
};

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

const quiet = { parse: [] };

const uid = () =>
  randomUUID().replaceAll('-', '').slice(0, 16);

class UserError extends Error {}

function need(ok, text) {
  if (!ok) throw new UserError(text);
}

const safe = value =>
  escapeMarkdown(String(value)).replaceAll('@', '@\u200b');

const digest = value =>
  createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');

const copy = value => structuredClone(value);

const clean = (value, max, label) => {
  const text = String(value || '')
    .trim()
    .replace(/[\u2013\u2014]/g, '-');

  need(
    text.length > 0 && text.length <= max,
    `${label}: entre 1 e ${max} caracteres.`
  );

  return text;
};

function fixtures(text) {
  return String(text || '')
    .split(/\s+\/\s+|\r?\n|\\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function programBlocks(program) {
  return Object.entries(GROUPS).filter(
    ([key]) => fixtures(program.blocks?.[key]).length
  );
}

function validateProgram(program) {
  dateKey(program.start);
  dateKey(program.end);

  need(
    program.start <= program.end,
    'A data de início deve ser anterior ou igual à data de fim.'
  );

  for (const [key] of programBlocks(program)) {
    need(
      fixtures(program.blocks[key])
        .map(value => '• ' + safe(value))
        .join('\n').length <= 1000,
      `O grupo ${key} é demasiado longo: encurta os nomes ou os horários.`
    );
  }
}

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
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
}

function day(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateKey(text) {
  need(
    /^\d{4}-\d{2}-\d{2}$/.test(text || ''),
    'Formato da data: AAAA-MM-DD.'
  );

  const timestamp = Date.parse(text + 'T12:00:00Z');

  need(
    Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === text,
    'Data inválida.'
  );

  return text;
}

function shift(text, count) {
  return new Date(
    Date.parse(dateKey(text) + 'T12:00:00Z') +
      count * 86400000
  )
    .toISOString()
    .slice(0, 10);
}

function monday(text) {
  const weekday = new Date(
    dateKey(text) + 'T12:00:00Z'
  ).getUTCDay();

  return shift(text, -(weekday === 0 ? 6 : weekday - 1));
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

function parseTime(value) {
  let text = String(value || '').trim();

  if (/^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/.test(text)) {
    text = text.slice(6) + ' ' + text.slice(0, 5);
  }

  need(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(
      text
    ),
    'Formato da hora: AAAA-MM-DD HH:mm, por exemplo 2026-11-10 09:00.'
  );

  dateKey(text.slice(0, 10));

  const utc = Date.parse(text.replace(' ', 'T') + ':00Z');
  const matches = [];

  for (let offset = -840; offset <= 840; offset += 15) {
    const timestamp = utc + offset * 60000;
    const p = parts(timestamp);

    if (
      `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` ===
      text
    ) {
      matches.push(timestamp);
    }
  }

  need(
    matches.length === 1,
    matches.length
      ? 'Hora ambígua devido à mudança de hora. Escolhe outro horário.'
      : 'Esta data ou hora não existe.'
  );

  return matches[0];
}

function imageURL(text) {
  if (!text) return '';

  let url;

  try {
    url = new URL(text);
  } catch {
    throw new UserError('URL da imagem inválido.');
  }

  need(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      text.length <= 1000,
    'Utiliza um URL HTTPS de imagem com menos de 1 000 caracteres.'
  );

  return text;
}

function odds(value) {
  const number = Number(
    String(value).trim().replace(',', '.')
  );

  need(
    Number.isFinite(number) && number >= 1 && number <= 10000,
    'Odd inválida: utiliza, por exemplo, 1,80.'
  );

  return String(value).trim();
}

const closeAt = match => Date.parse(match.closingTimeUTC);

function isOpen(match, now = Date.now()) {
  return (
    match.status === 'open' &&
    match.result === null &&
    now < closeAt(match)
  );
}

function getMatch(state, id) {
  const match = state.matches[id];

  need(
    match && match.status !== 'deleted',
    'Jogo não encontrado. Utiliza /list-matches para consultar o ID.'
  );

  return match;
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

function migrate(state) {
  need(
    state &&
      state.matches &&
      state.bets &&
      state.users &&
      (!state.schema || state.schema === 3),
    'Formato de cópia de segurança desconhecido. Não apagues o ficheiro db.json.'
  );

  state.schema = 3;
  state.programs ||= {};
  state.boosts ||= {};
  state.pending ||= {};
  state.archives ||= [];

  for (const match of Object.values(state.matches)) {
    need(
      Number.isFinite(closeAt(match)),
      `Data de fecho inválida no jogo ${match.id}.`
    );

    match.result =
      match.result == null
        ? null
        : Array.isArray(match.result)
          ? match.result
          : [match.result];

    match.publishAt ??= match.messageId ? 0 : Date.now();
    match.date ||= sportDay(closeAt(match));
    match.revision ||= 1;
    match.version ||= 1;
    match.description ||= '';
    match.roleId ||= null;
    match.imageUrl ||= '';
    match.dirty = true;
    match.published ||= Boolean(match.messageId);
    match.imageFile ||= '';

    for (const [id, bet] of Object.entries(
      state.bets[match.id] || {}
    )) {
      bet.revision ||= match.revision;

      if (bet.boosted) {
        const key = bet.boostDay || match.date;
        state.boosts[key] ||= {};
        state.boosts[key][id] ||= match.id;
      }
    }
  }

  for (const program of Object.values(state.programs)) {
    if (!program.blocks) {
      program.blocks = Object.fromEntries(
        Object.keys(GROUPS).map(key => [key, ''])
      );

      const selected = Object.values(state.matches)
        .filter(
          match =>
            match.status !== 'deleted' &&
            match.channelId ===
              (program.matchesChannelId || program.channelId) &&
            match.date >= program.start &&
            match.date <= program.end
        )
        .sort((a, b) => closeAt(a) - closeAt(b));

      for (const match of selected) {
        const weekday = new Date(
          match.date + 'T12:00:00Z'
        ).getUTCDay();

        const key =
          { 2: 'mardi', 3: 'mercredi', 4: 'jeudi' }[weekday] ||
          'weekend';

        program.blocks[key] +=
          (program.blocks[key] ? ' / ' : '') + match.title;
      }
    }

    program.version ||= 1;
    program.dirty = true;
  }

  return state;
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
        JSON.parse(await fs.readFile(this.file, 'utf8'))
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = initial();
    }

    await this.write(this.state);
  }

  async write(state) {
    const handle = await fs.open(
      this.file + '.tmp',
      'w',
      0o600
    );

    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.copyFile(this.file, this.file + '.bak');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
      const returned = await fn(next);

      await this.write(next);
      this.state = next;

      return copy(returned);
    });

    this.queue = task.catch(() => {});
    return task;
  }
}

function earned(match, bet) {
  return (
    match.status !== 'deleted' &&
    bet.revision === match.revision &&
    match.result?.includes(bet.choice)
  )
    ? BASE[bet.choice] * (bet.boosted ? 2 : 1)
    : 0;
}

function rank(state, range = {}) {
  const users = new Map();

  for (const match of Object.values(state.matches)) {
    if (
      match.status === 'deleted' ||
      (range.start && match.date < range.start) ||
      (range.end && match.date > range.end)
    ) {
      continue;
    }

    for (const [id, bet] of Object.entries(
      state.bets[match.id] || {}
    )) {
      if (bet.revision !== match.revision) continue;

      const entry = users.get(id) || {
        id,
        name:
          state.users[id]?.username ||
          bet.username ||
          id,
        points: 0,
        first: Infinity,
      };

      entry.points += earned(match, bet);
      entry.first = Math.min(
        entry.first,
        bet.placedAt || Infinity
      );

      users.set(id, entry);
    }
  }

  return [...users.values()]
    .filter(entry => entry.points > 0)
    .sort(
      (a, b) =>
        b.points - a.points ||
        a.first - b.first ||
        a.id.localeCompare(b.id)
    );
}

function boostAvailable(state, userId, now = Date.now()) {
  const key = sportDay(now);

  return (
    !state.boosts[key]?.[userId] &&
    state.users[userId]?.boostUsedToday !== key
  );
}

function place(
  state,
  matchId,
  userId,
  choice,
  boost,
  revision,
  username,
  now = Date.now()
) {
  const match = getMatch(state, matchId);

  need(
    isOpen(match, now),
    'As participações estão encerradas.'
  );

  need(
    match.revision === revision && BASE[choice],
    'Esta opção foi alterada. Volta à mensagem do jogo.'
  );

  need(
    !state.bets[matchId]?.[userId],
    'Já participaste. O teu palpite não pode ser alterado.'
  );

  need(
    !boost || boostAvailable(state, userId, now),
    'Já utilizaste o teu boost nesta jornada.'
  );

  const key = sportDay(now);

  state.bets[matchId] ||= {};
  state.users[userId] ||= { totalPoints: 0 };

  state.bets[matchId][userId] = {
    choice,
    boosted: boost,
    revision,
    username,
    placedAt: now,
    boostDay: boost ? key : null,
    points: null,
  };

  Object.assign(state.users[userId], {
    username,
    firstBetAt: state.users[userId].firstBetAt || now,
  });

  if (boost) {
    state.boosts[key] ||= {};
    state.boosts[key][userId] = matchId;
    state.users[userId].boostUsedToday = key;
  }
}

function result(state, matchId, winners) {
  const match = getMatch(state, matchId);

  match.result = winners;
  match.status = 'closed';
  match.dirty = true;
  match.version++;

  for (const bet of Object.values(
    state.bets[matchId] || {}
  )) {
    bet.points = earned(match, bet);
  }

  for (const user of Object.values(state.users)) {
    user.totalPoints = 0;
  }

  for (const entry of rank(state)) {
    if (state.users[entry.id]) {
      state.users[entry.id].totalPoints = entry.points;
    }
  }
}

function rangeOptions(options) {
  const start = options.getString('debut');
  const end = options.getString('fin');

  if (start || end) {
    need(
      start && end,
      'Preenche os campos debut E fin.'
    );

    dateKey(start);
    dateKey(end);
    need(start <= end, 'Período inválido.');

    return {
      start,
      end,
      label: `de ${start} a ${end}`,
    };
  }

  const type = options.getString('type') || 'week';

  if (type === 'general') {
    return { label: 'geral' };
  }

  if (type === 'today') {
    const date = sportDay();

    return {
      start: date,
      end: date,
      label: `de ${date}`,
    };
  }

  const date = monday(day(Date.now()));

  return {
    start: date,
    end: shift(date, 6),
    label: `de ${date} a ${shift(date, 6)}`,
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
  disabled = false
) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled);

const row = (...buttons) =>
  new ActionRowBuilder().addComponents(buttons);

function media(item, card) {
  if (item.imageFile) {
    const name = path.basename(item.imageFile);

    card.setImage(`attachment://${name}`);

    return {
      files: [
        new AttachmentBuilder(item.imageFile, { name }),
      ],
    };
  }

  if (item.imageUrl) card.setImage(item.imageUrl);

  return {};
}

function longText(card, intro, suffix) {
  card.setDescription(suffix || null);

  const budget = Math.min(
    4096 - suffix.length,
    6000 - card.length
  );

  let content = '';
  let rest = intro;

  if (intro.length > budget) {
    const required = intro.length - budget;

    need(
      required <= 1900,
      'A mensagem é demasiado longa para o Discord: encurta o texto ou as restantes informações.'
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
    'A mensagem formatada é demasiado longa: encurta ligeiramente o texto.'
  );

  card.setDescription(rest + suffix);

  return content;
}

function matchCard(match) {
  const open = isOpen(match);

  const card = embed(match.title)
    .setColor(open ? COLOR : 0x7F1D1D);

  const intro =
    match.description ||
    'Escolhe o teu palpite e tenta chegar ao topo da classificação!';

  const lines = [
    '',
    '',
    `🕒 **Fim das participações: ${time(closeAt(match))}**`,
    '',
  ];

  for (const number of [1, 2, 3]) {
    lines.push(
      `${EMOJIS[number]} **${safe(
        match['choice' + number + 'Label']
      )}**`,
      `*Odd: ${safe(
        match['choice' + number + 'Odds']
      )}* · ${ICON} **${BASE[number]} ${UNIT}**`,
      ''
    );
  }

  lines.push(
    '⚡ Um boost por jornada para duplicar os pontos que ganhares.',
    'Depois de confirmado, o teu palpite é definitivo.'
  );

  if (!open) {
    lines.push(
      '',
      match.result
        ? '🔒 Resultados registados.'
        : '🔒 As participações estão encerradas.'
    );
  }

  card.setFooter({
    text: `Betclic MatchDay | Match ${match.id}`,
  });

  const content = longText(
    card,
    intro,
    lines.join('\n')
  );

  return {
    content,
    embeds: [card],
    ...media(match, card),
    components: [
      row(
        ...[1, 2, 3].map(number =>
          button(
            `md:bet:${match.id}:${number}:${match.revision}`,
            `${EMOJIS[number]} ${NAMES[number]} (+${BASE[number]} ${UNIT})`,
            [
              0,
              ButtonStyle.Secondary,
              ButtonStyle.Primary,
              ButtonStyle.Danger,
            ][number],
            !open
          )
        ),
        button(
          `md:my:${match.id}`,
          '📋 A minha escolha'
        )
      ),
    ],
    allowedMentions: quiet,
  };
}

function myCard(state, match, userId) {
  const bet = state.bets[match.id]?.[userId];

  if (!bet) {
    return {
      content:
        'Ainda não confirmaste nenhum palpite neste jogo.',
      embeds: [],
      components: [],
    };
  }

  const card = embed('✅ O teu palpite foi registado')
    .setColor(0x22C55E)
    .setDescription(
      [
        `**${safe(match.title)}**`,
        '',
        `${EMOJIS[bet.choice]} **${safe(
          match['choice' + bet.choice + 'Label']
        )}**`,
        '',
        `${ICON} **${
          BASE[bet.choice] * (bet.boosted ? 2 : 1)
        } ${UNIT}** se a tua escolha for vencedora.${
          bet.boosted ? ' Boost x2 ativado.' : ''
        }`,
        '',
        'A tua escolha é definitiva.',
        match.result
          ? `\nResultado: **${earned(
              match,
              bet
            )} ${UNIT} ganhos**.`
          : '',
      ].join('\n')
    );

  return {
    content: '',
    embeds: [card],
    components: [],
    allowedMentions: quiet,
  };
}

function weekMatches(state, program) {
  return programBlocks(program).flatMap(([key]) =>
    fixtures(program.blocks[key]).map(title => ({
      title,
      group: key,
    }))
  );
}

function weekCard(state, program) {
  const groups = programBlocks(program);

  const custom = Boolean(
    String(program.description || '').trim()
  );

  const intro = custom
    ? program.description
    : EDITION.description;

  const card = embed(program.title);

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
              let date = program.start;
              date <= program.end;
              date = shift(date, 1)
            ) {
              if (
                new Date(
                  date + 'T12:00:00Z'
                ).getUTCDay() === target
              ) {
                return (
                  ' ' +
                  date.slice(8) +
                  '/' +
                  date.slice(5, 7)
                );
              }
            }

            return '';
          })();

    const chunks = [];
    let chunk = '';

    for (const fixture of fixtures(program.blocks[key])) {
      const line = '• ' + safe(fixture);

      if (
        chunk &&
        chunk.length + line.length + 1 > 1024
      ) {
        chunks.push(chunk);
        chunk = '';
      }

      chunk += (chunk ? '\n' : '') + line;
    }

    if (chunk) chunks.push(chunk);

    chunks.forEach((value, index) => {
      card.addFields({
        name:
          label +
          date +
          (index ? ' (continuação)' : ''),
        value: value + '\n\u200b',
        inline: false,
      });
    });
  }

  if (!custom && program.rulesChannelId) {
    card.addFields({
      name: '📋 Regulamento',
      value: `<#${program.rulesChannelId}>`,
    });
  }

  const disclaimer = /f(?:r)?eebets?/i.test(intro)
    ? ' | Feebets = créditos de jogo não levantáveis'
    : '';

  card.setFooter({
    text: `Betclic MatchDay | Programme ${program.id}${disclaimer}`,
  });

  const content = longText(card, intro, '');

  return {
    content,
    embeds: [card],
    ...media(program, card),
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
      }
    );

    for (const number of [1, 2, 3]) {
      fields.push({
        name: `${EMOJIS[number]} Opção ${number} · ${BASE[number]} ${UNIT}`,
        value: `${safe(
          item[`choice${number}Label`]
        )}\nOdd: **${safe(
          item[`choice${number}Odds`]
        )}**`,
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
              ? item.result
                  .map(number => `Opção ${number}`)
                  .join(', ')
              : 'Nenhuma opção vencedora',
      },
      {
        name: 'Editar este jogo',
        value:
          `Utiliza **/edit-match** com match_id: \`${item.id}\`\n` +
          'Podes editar o texto, o título, a imagem e os parâmetros disponíveis. As opções, odds e jornada ficam bloqueadas após a primeira participação.',
      }
    );
  } else {
    fields.push(
      {
        name: 'Semana',
        value: `${item.start} a ${item.end}`,
      },
      {
        name: 'Canal dos jogos',
        value: `<#${
          item.matchesChannelId || item.channelId
        }>`,
      }
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

function rankCard(state, range, page = 0) {
  const all = rank(state, range);
  const pages = Math.max(1, Math.ceil(all.length / 20));

  page = Math.max(
    0,
    Math.min(Number(page) || 0, pages - 1)
  );

  const pending = Object.values(state.matches).filter(
    match =>
      match.status !== 'deleted' &&
      (!range.start || match.date >= range.start) &&
      (!range.end || match.date <= range.end) &&
      match.result === null
  ).length;

  const card = embed(`🏆 Classificação ${range.label}`)
    .setDescription(
      all
        .slice(page * 20, page * 20 + 20)
        .map(
          (user, index) =>
            `${
              ['🥇', '🥈', '🥉'][page * 20 + index] ||
              `**${page * 20 + index + 1}.**`
            } <@${user.id}> | ${ICON} **${user.points} ${UNIT}**`
        )
        .join('\n') || 'Ainda não há pontos.'
    )
    .setFooter({
      text: `Betclic MatchDay | Página ${page + 1}/${pages}`,
    });

  if (pending) {
    card.addFields({
      name: '⏳ Classificação provisória',
      value: `${pending} resultado(s) pendente(s) neste período.`,
    });
  }

  card.addFields({
    name: 'Em caso de empate',
    value:
      'Em caso de empate, fica à frente quem participou primeiro no período.',
  });

  return {
    content: '',
    embeds: [card],
    components:
      pages > 1
        ? [
            row(
              button(
                `md:rank:${range.start || 'all'}:${range.end || 'all'}:${page - 1}`,
                '←',
                ButtonStyle.Secondary,
                page === 0
              ),
              button(
                `md:rank:${range.start || 'all'}:${range.end || 'all'}:${page + 1}`,
                '→',
                ButtonStyle.Secondary,
                page === pages - 1
              )
            ),
          ]
        : [],
    allowedMentions: quiet,
  };
}

function matchOptions(command, editing = false) {
  if (editing) {
    command.addStringOption(option =>
      option
        .setName('match_id')
        .setDescription(
          'ID no canal da equipa ou em /list-matches'
        )
        .setRequired(true)
    );
  }

  command
    .addStringOption(option =>
      option
        .setName('titre')
        .setDescription('Título livre do MatchDay')
        .setMaxLength(180)
        .setRequired(!editing)
    )
    .addStringOption(option =>
      option
        .setName('fermeture')
        .setDescription(
          'Fim das participações: AAAA-MM-DD HH:mm, fuso horário configurado'
        )
        .setRequired(!editing)
    );

  for (const number of [1, 2, 3]) {
    command
      .addStringOption(option =>
        option
          .setName(`choix${number}_label`)
          .setDescription(
            `Opção ${number}: ${BASE[number]} pontos`
          )
          .setMaxLength(180)
          .setRequired(!editing)
      )
      .addStringOption(option =>
        option
          .setName(`choix${number}_cote`)
          .setDescription(
            `Odd indicativa da opção ${number}`
          )
          .setMaxLength(20)
          .setRequired(!editing)
      );
  }

  command
    .addStringOption(option =>
      option
        .setName('publication')
        .setDescription(
          'AAAA-MM-DD HH:mm; publicação imediata se não preencheres'
        )
    )
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription(
          'Canal de destino; canal atual se não preencheres'
        )
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        )
    )
    .addStringOption(option =>
      option
        .setName('journee')
        .setDescription(
          'Jornada AAAA-MM-DD; por defeito, calculada a partir do início do jogo'
        )
    )
    .addStringOption(option =>
      option
        .setName('texte')
        .setDescription(
          'Apresentação opcional, até 5 000 caracteres'
        )
        .setMaxLength(5000)
    )
    .addStringOption(option =>
      option
        .setName('image')
        .setDescription('URL da imagem, opcional')
        .setMaxLength(1000)
    )
    .addRoleOption(option =>
      option
        .setName('notification')
        .setDescription(
          'Cargo a mencionar na publicação, opcional'
        )
    );

  if (editing) {
    command
      .addBooleanOption(option =>
        option
          .setName('retirer_image')
          .setDescription('Remover a imagem')
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_notification')
          .setDescription('Remover a notificação')
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_texte')
          .setDescription('Repor o texto predefinido')
      );
  }

  return command;
}

function programOptions(command, editing = false) {
  if (editing) {
    command.addStringOption(option =>
      option
        .setName('programme_id')
        .setDescription('ID do programa no canal da equipa')
        .setRequired(true)
    );
  }

  command
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription(
          'Canal do anúncio; canal atual se não preencheres'
        )
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        )
    )
    .addStringOption(option =>
      option
        .setName('publication')
        .setDescription(
          'AAAA-MM-DD HH:mm, fuso TIMEZONE; imediato se não preencheres'
        )
    )
    .addChannelOption(option =>
      option
        .setName('salon_matchs')
        .setDescription(
          'Canal onde os membros participam nos MatchDays'
        )
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        )
    )
    .addStringOption(option =>
      option
        .setName('image')
        .setDescription('Ligação da imagem do anúncio')
        .setMaxLength(1000)
    )
    .addStringOption(option =>
      option
        .setName('titre')
        .setDescription(
          'Título do anúncio; BETCLIC MATCHDAY se não preencheres'
        )
        .setMaxLength(180)
    )
    .addStringOption(option =>
      option
        .setName('texte')
        .setDescription(
          'Introdução personalizada, até 5 000 caracteres'
        )
        .setMaxLength(5000)
    )
    .addStringOption(option =>
      option
        .setName('debut')
        .setDescription(
          'Início AAAA-MM-DD; por defeito, segunda-feira da semana atual'
        )
    )
    .addStringOption(option =>
      option
        .setName('fin')
        .setDescription(
          'Fim AAAA-MM-DD; por defeito, domingo da semana atual'
        )
    );

  for (const key of Object.keys(GROUPS)) {
    command.addStringOption(option =>
      option
        .setName(key)
        .setDescription(
          `Jogos: ${GROUPS[key]}, separados por /; escreve nenhum para remover`
        )
        .setMaxLength(450)
    );
  }

  command
    .addRoleOption(option =>
      option
        .setName('notification')
        .setDescription(
          'Cargo a mencionar na publicação, opcional'
        )
    )
    .addChannelOption(option =>
      option
        .setName('reglement')
        .setDescription('Canal do regulamento, opcional')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        )
    );

  if (editing) {
    command
      .addBooleanOption(option =>
        option
          .setName('retirer_image')
          .setDescription('Remover a imagem')
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_notification')
          .setDescription('Remover a notificação')
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_texte')
          .setDescription('Repor o texto predefinido')
      );
  }

  return command;
}

function ranges(command) {
  return command
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Semana atual por defeito')
        .addChoices(
          { name: 'Semana', value: 'week' },
          {
            name: 'Jornada desportiva',
            value: 'today',
          },
          { name: 'Geral', value: 'general' }
        )
    )
    .addStringOption(option =>
      option
        .setName('debut')
        .setDescription(
          'Início personalizado: AAAA-MM-DD'
        )
    )
    .addStringOption(option =>
      option
        .setName('fin')
        .setDescription('Fim personalizado: AAAA-MM-DD')
    );
}

const adminCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(P.Administrator);

const idOption = (command, name = 'match_id') =>
  command.addStringOption(option =>
    option
      .setName(name)
      .setDescription('ID na ficha da equipa')
      .setRequired(true)
  );

const commands = [
  matchOptions(
    adminCommand(
      'create-match',
      'Criar um MatchDay imediato ou agendado'
    )
  ),
  matchOptions(
    adminCommand('edit-match', 'Editar um MatchDay'),
    true
  ),
  idOption(
    adminCommand(
      'close-match',
      'Encerrar imediatamente as participações'
    )
  ),
  idOption(
    adminCommand(
      'delete-match',
      'Eliminar um MatchDay com confirmação'
    )
  ),
  idOption(
    adminCommand(
      'set-result',
      'Registar ou corrigir as opções vencedoras'
    )
  )
    .addBooleanOption(option =>
      option
        .setName('choix1')
        .setDescription('A opção 1 é vencedora')
    )
    .addBooleanOption(option =>
      option
        .setName('choix2')
        .setDescription('A opção 2 é vencedora')
    )
    .addBooleanOption(option =>
      option
        .setName('choix3')
        .setDescription('A opção 3 é vencedora')
    )
    .addBooleanOption(option =>
      option
        .setName('annule')
        .setDescription('Anular o jogo: sem pontos')
    ),
  programOptions(
    adminCommand(
      'schedule-week',
      'Criar o anúncio do programa da semana'
    )
  ),
  programOptions(
    adminCommand(
      'edit-week',
      'Editar o anúncio da semana'
    ),
    true
  ),
  idOption(
    adminCommand(
      'delete-week',
      'Eliminar um programa com confirmação'
    ),
    'programme_id'
  ),
  ranges(
    new SlashCommandBuilder()
      .setName('classement')
      .setDescription(
        'Mostrar a classificação a pedido'
      )
  ).addBooleanOption(option =>
    option
      .setName('prive')
      .setDescription('Mostrar apenas para ti')
  ),
  adminCommand(
    'list-matches',
    'Listar os MatchDays e os programas'
  ).addStringOption(option =>
    option
      .setName('semaine')
      .setDescription(
        'Filtrar por uma data AAAA-MM-DD da semana'
      )
  ),
  ranges(
    adminCommand(
      'export',
      'Exportar os palpites e a classificação em CSV'
    )
  ),
  adminCommand(
    'reset-scores',
    'Arquivar e repor todos os jogos e pontos a zero, com confirmação'
  ),
  adminCommand(
    'diagnostic',
    'Verificar os dados guardados e os agendamentos'
  ),
];

async function cacheImage(item, dir) {
  item.imageFile = '';

  if (!item.imageUrl) return;

  const url = new URL(item.imageUrl);

  if (
    ![
      'cdn.discordapp.com',
      'media.discordapp.net',
    ].includes(url.hostname)
  ) {
    return;
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  need(
    response.ok,
    'Ligação Discord expirada ou inacessível. Copia novamente a ligação da imagem.'
  );

  const extension = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[
    response.headers
      .get('content-type')
      ?.split(';')[0]
  ];

  need(
    extension,
    'Formatos de imagem: PNG, JPG, WEBP ou GIF.'
  );

  need(
    Number(
      response.headers.get('content-length') || 0
    ) <=
      8 * 1024 * 1024,
    'Imagem demasiado grande: máximo de 8 MB.'
  );

  const chunks = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.length;

    need(
      size <= 8 * 1024 * 1024,
      'Imagem demasiado grande: máximo de 8 MB.'
    );

    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const folder = path.join(dir, 'images');

  await fs.mkdir(folder, { recursive: true });

  item.imageFile = path.join(
    folder,
    `${item.id}-${createHash('sha256')
      .update(buffer)
      .digest('hex')
      .slice(0, 12)}${extension}`
  );

  await fs.writeFile(item.imageFile, buffer, {
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
    'Preenche DISCORD_TOKEN e DISCORD_GUILD_ID.'
  );

  need(
    !staffId || /^\d{17,20}$/.test(staffId),
    'DISCORD_ADMIN_CHANNEL_ID inválido.'
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
      'Liga o volume e configura DATA_DIR com o mesmo caminho.'
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

  const admin = interaction =>
    need(
      interaction.memberPermissions?.has(
        P.Administrator
      ),
      'Este comando está reservado aos administradores.'
    );

  const log = (label, error) => {
    const message = String(
      error?.message || 'Erro sem detalhes'
    ).replaceAll(
      env.DISCORD_TOKEN,
      '[TOKEN OCULTO]'
    );

    console.error(
      `${label}: ${
        error?.code || error?.name || 'Erro'
      } | ${message.slice(0, 1500)}`
    );
  };

  async function channel(id) {
    const result = await client.channels.fetch(id);

    need(
      result &&
        result.guildId === guildId &&
        [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ].includes(result.type),
      'Canal inacessível ou pertencente a outro servidor.'
    );

    need(
      result.permissionsFor(client.user)?.has([
        P.ViewChannel,
        P.SendMessages,
        P.EmbedLinks,
        P.AttachFiles,
        P.ReadMessageHistory,
      ]),
      'O bot precisa de permissões para ver o canal, enviar mensagens, incorporar ligações, anexar ficheiros e ler o histórico.'
    );

    return result;
  }

  async function fetchMessage(targetChannel, id) {
    try {
      return await targetChannel.messages.fetch(id);
    } catch (error) {
      if (error.code !== 10008) throw error;
      return null;
    }
  }

  async function findMessage(
    targetChannel,
    marker,
    since
  ) {
    if (!since) return null;

    let before;

    for (let page = 0; page < 100; page++) {
      const list = await targetChannel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!list.size) return null;

      const found = list.find(
        message =>
          message.author.id === client.user.id &&
          message.embeds.some(card =>
            card.footer?.text?.startsWith(marker)
          )
      );

      if (found) return found;

      const last = list.last();

      if (last.createdTimestamp < since - 10000) {
        return null;
      }

      before = last.id;
    }

    throw new Error(
      'Histórico demasiado longo para verificar um envio interrompido.'
    );
  }

  async function syncStaff(item, kind) {
    if (!staffId || item.status === 'deleted') return;

    if (
      kind === 'matches' &&
      !item.staffMessageId &&
      (item.status === 'closed' ||
        closeAt(item) <= Date.now())
    ) {
      return;
    }

    const payload = staffCard(item, kind);
    const hash = digest(
      payload.embeds.map(card => card.toJSON())
    );

    if (
      item.staffHash === hash &&
      item.staffChannelId === staffId
    ) {
      return;
    }

    const targetChannel = await channel(staffId);

    let previous =
      item.staffChannelId === staffId &&
      item.staffMessageId
        ? await fetchMessage(
            targetChannel,
            item.staffMessageId
          )
        : null;

    if (!previous && item.staffMessageId) return;

    if (!previous && item.staffSendingAt) {
      previous = await findMessage(
        targetChannel,
        `Betclic MatchDay | Staff ${kind} ${item.id}`,
        item.staffSendingAt
      );
    }

    if (!previous && !item.staffSendingAt) {
      await store.change(state => {
        state[kind][item.id].staffSendingAt =
          Date.now();
      });
    }

    const message = previous
      ? await previous.edit(payload)
      : await targetChannel.send({
          ...payload,
          nonce: BigInt(
            '0x' +
              digest(
                `staff:${kind}:${item.id}`
              ).slice(0, 16)
          ).toString(),
          enforceNonce: true,
        });

    await store.change(state => {
      Object.assign(state[kind][item.id], {
        staffMessageId: message.id,
        staffChannelId: staffId,
        staffHash: hash,
      });
    });
  }

  async function publish(item, kind, state) {
    const isWeek = kind === 'programs';

    if (item.status === 'deleted') {
      if (item.messageId) {
        const targetChannel = await channel(
          item.postChannelId || item.channelId
        );

        const message = await fetchMessage(
          targetChannel,
          item.messageId
        );

        if (message) await message.delete();

        await store.change(database => {
          database[kind][item.id].messageId = null;
        });
      }

      return;
    }

    if (
      !item.published &&
      item.publishAt > Date.now()
    ) {
      return;
    }

    if (
      !isWeek &&
      !item.published &&
      closeAt(item) <= Date.now()
    ) {
      if (!item.missed) {
        await store.change(database => {
          database.matches[item.id].missed = true;
          database.matches[item.id].status = 'closed';
          database.matches[item.id].version++;
        });

        log(
          `Publicação falhada ${item.id}`,
          new Error(
            'O jogo já começou. Não foi publicado.'
          )
        );
      }

      return;
    }

    const payload = isWeek
      ? weekCard(state, item)
      : matchCard({
          ...item,
          status:
            item.status === 'scheduled'
              ? 'open'
              : item.status,
        });

    const hash = digest({
      content: payload.content || '',
      embeds: payload.embeds.map(card => card.toJSON()),
      components: payload.components.map(component =>
        component.toJSON()
      ),
      image: item.imageUrl,
      file: item.imageFile,
    });

    if (
      item.published &&
      item.publicHash === hash &&
      !item.dirty
    ) {
      return;
    }

    const moving = Boolean(
      item.messageId &&
        item.postChannelId &&
        item.postChannelId !== item.channelId
    );

    if (moving) {
      const oldChannel = await channel(
        item.postChannelId
      );

      const oldMessage = await fetchMessage(
        oldChannel,
        item.messageId
      );

      if (oldMessage) await oldMessage.delete();

      await store.change(database => {
        const saved = database[kind][item.id];
        saved.messageId = null;
        saved.sendingAt = null;
      });

      item.messageId = null;
      item.sendingAt = null;
    }

    const targetChannel = await channel(item.channelId);

    let previous = item.messageId
      ? await fetchMessage(
          targetChannel,
          item.messageId
        )
      : null;

    // Un message déjà publié puis supprimé n'est pas recréé.
    if (item.published && !previous && !moving) {
      await store.change(database => {
        const latest = database[kind][item.id];

        if (latest.version === item.version) {
          latest.publicHash = hash;
          latest.dirty = false;
        }
      });

      return;
    }

    if (
      !previous &&
      !item.messageId &&
      item.sendingAt
    ) {
      previous = await findMessage(
        targetChannel,
        isWeek
          ? `Betclic MatchDay | Programme ${item.id} |`
          : `Betclic MatchDay | Match ${item.id}`,
        item.sendingAt
      );
    }

    if (!previous && !item.sendingAt) {
      item.sendingAt = Date.now();

      await store.change(database => {
        database[kind][item.id].sendingAt =
          item.sendingAt;
      });
    }

    const notify = !item.published && item.roleId;

    const message = previous
      ? await previous.edit({
          ...payload,
          attachments: [],
          content: payload.content || '',
          allowedMentions: quiet,
        })
      : await targetChannel.send({
          ...payload,
          content: [
            notify ? `<@&${item.roleId}>` : '',
            payload.content || '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          allowedMentions: notify
            ? {
                parse: [],
                roles: [item.roleId],
              }
            : quiet,
          nonce: BigInt(
            '0x' +
              digest(
                `${kind}:${item.id}:${item.sendingAt}`
              ).slice(0, 16)
          ).toString(),
          enforceNonce: true,
        });

    const remove = await store.change(database => {
      const latest = database[kind][item.id];

      latest.messageId = message.id;
      latest.postChannelId = item.channelId;

      if (latest.status === 'deleted') return true;

      latest.published = true;

      if (latest.version === item.version) {
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

      await store.change(database => {
        database[kind][item.id].messageId = null;
      });
    }
  }

  async function tick() {
    if (
      ticking ||
      stopping ||
      !client.isReady()
    ) {
      return;
    }

    ticking = true;

    try {
      const current = await store.read();

      if (
        Object.values(current.matches).some(
          match =>
            match.status === 'open' &&
            closeAt(match) <= Date.now()
        )
      ) {
        await store.change(state => {
          for (const match of Object.values(
            state.matches
          )) {
            if (
              match.status === 'open' &&
              closeAt(match) <= Date.now()
            ) {
              match.status = 'closed';
              match.dirty = true;
              match.version++;
            }
          }
        });
      }

      const state = await store.read();

      for (const kind of ['programs', 'matches']) {
        for (const item of Object.values(
          state[kind]
        ).sort((a, b) => a.publishAt - b.publishAt)) {
          try {
            await syncStaff(item, kind);
          } catch (error) {
            log(`Ficha da equipa ${item.id}`, error);
          }

          try {
            await publish(item, kind, state);
          } catch (error) {
            log(`Publicação ${item.id}`, error);
          }
        }
      }
    } catch (error) {
      log('Agendamento', error);
    } finally {
      ticking = false;
    }
  }

  async function ask(interaction, data) {
    const token = uid();

    await store.change(state => {
      state.pending[token] = {
        ...data,
        uid: interaction.user.id,
        expires: Date.now() + 900000,
      };
    });

    const text =
      data.kind === 'reset'
        ? '⚠️ Arquivar todos os jogos, programas, pontos e boosts e recomeçar do zero?'
        : data.table === 'programs'
          ? '⚠️ Eliminar este anúncio? Os jogos e os palpites serão mantidos.'
          : '⚠️ Eliminar este MatchDay? Os seus pontos serão removidos das classificações. Será arquivada uma cópia.';

    return interaction.editReply({
      content: text,
      embeds: [],
      components: [
        row(
          button(
            `md:yes:${token}`,
            'Confirmar',
            ButtonStyle.Danger
          ),
          button(
            `md:no:${token}`,
            'Cancelar'
          )
        ),
      ],
    });
  }

  async function slash(interaction) {
    need(
      interaction.guildId === guildId,
      'Utiliza este comando no servidor configurado.'
    );

    const name = interaction.commandName;

    if (name !== 'classement') {
      admin(interaction);
    }

    await interaction.deferReply({
      flags:
        name === 'classement' &&
        !interaction.options.getBoolean('prive')
          ? undefined
          : MessageFlags.Ephemeral,
    });

    if (
      name === 'create-match' ||
      name === 'edit-match'
    ) {
      const options = interaction.options;
      const editing = name === 'edit-match';
      const state = await store.read();

      const old = editing
        ? getMatch(
            state,
            options.getString('match_id')
          )
        : null;

      const match = old
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

      if (options.getString('titre') !== null) {
        match.title = clean(
          options.getString('titre'),
          180,
          'Título'
        );
      }

      if (options.getString('fermeture')) {
        match.closingTimeUTC = new Date(
          parseTime(
            options.getString('fermeture')
          )
        ).toISOString();
      }

      for (const number of [1, 2, 3]) {
        if (
          options.getString(
            `choix${number}_label`
          ) !== null
        ) {
          match[`choice${number}Label`] = clean(
            options.getString(
              `choix${number}_label`
            ),
            180,
            'Opção'
          );
        }

        if (
          options.getString(
            `choix${number}_cote`
          ) !== null
        ) {
          match[`choice${number}Odds`] = odds(
            options.getString(
              `choix${number}_cote`
            )
          );
        }
      }

      if (options.getString('publication')) {
        need(
          !old?.published,
          'O jogo já foi publicado: o horário de publicação não pode ser alterado.'
        );

        match.publishAt = parseTime(
          options.getString('publication')
        );
      }

      if (options.getChannel('channel')) {
        match.channelId =
          options.getChannel('channel').id;
      }

      match.channelId ||= interaction.channelId;

      match.date = options.getString('journee')
        ? dateKey(options.getString('journee'))
        : old?.date || sportDay(closeAt(match));

      if (options.getString('texte') !== null) {
        match.description = options.getString('texte');
      }

      if (options.getString('image') !== null) {
        match.imageUrl = imageURL(
          options.getString('image')
        );
      }

      if (options.getRole('notification')) {
        match.roleId =
          options.getRole('notification').id;
      }

      if (
        editing &&
        options.getBoolean('retirer_image')
      ) {
        match.imageUrl = '';
        match.imageFile = '';
      }

      if (
        editing &&
        options.getBoolean('retirer_notification')
      ) {
        match.roleId = null;
      }

      if (
        editing &&
        options.getBoolean('retirer_texte')
      ) {
        match.description = '';
      }

      need(
        match.publishAt < closeAt(match),
        'A publicação deve ser anterior ao fecho das participações.'
      );

      if (!old?.published) {
        need(
          closeAt(match) > Date.now() &&
            (!options.getString('publication') ||
              match.publishAt > Date.now()),
          'Escolhe datas futuras.'
        );
      }

      if (
        old &&
        (old.status === 'closed' ||
          closeAt(old) <= Date.now())
      ) {
        need(
          closeAt(match) <= closeAt(old),
          'Um jogo encerrado não pode ser reaberto.'
        );

        match.status = 'closed';
      }

      const changedChoices =
        old &&
        [1, 2, 3].some(
          number =>
            match[`choice${number}Label`] !==
              old[`choice${number}Label`] ||
            match[`choice${number}Odds`] !==
              old[`choice${number}Odds`]
        );

      const sensitive =
        changedChoices ||
        (old && match.date !== old.date);

      matchCard(match);

      await channel(match.channelId);

      if (
        !old ||
        match.imageUrl !== old.imageUrl
      ) {
        await cacheImage(match, store.dir);
      }

      await store.change(state => {
        if (old) {
          const latest = getMatch(
            state,
            match.id
          );

          need(
            latest.version === old.version,
            'O jogo foi alterado. Tenta novamente.'
          );

          need(
            !sensitive ||
              !Object.keys(
                state.bets[match.id] || {}
              ).length,
            'Já existem palpites: não podes alterar as opções, as odds ou a jornada.'
          );

          Object.assign(match, {
            published: latest.published,
            status:
              latest.status === 'scheduled' &&
              match.status === 'closed'
                ? 'closed'
                : latest.status,
            messageId: latest.messageId,
            postChannelId: latest.postChannelId,
            sendingAt: latest.sendingAt,
            staffMessageId: latest.staffMessageId,
            staffChannelId: latest.staffChannelId,
            staffSendingAt: latest.staffSendingAt,
          });

          if (sensitive) match.revision++;
        }

        match.version++;
        match.dirty = true;

        state.matches[match.id] = match;
        state.bets[match.id] ||= {};
      });

      void tick();

      return interaction.editReply(
        `✅ MatchDay ${
          editing ? 'atualizado' : 'criado'
        }.\n` +
          `ID: \`${match.id}\`\n` +
          `Publicação: ${time(match.publishAt)}\n` +
          `Fim das participações: ${time(
            closeAt(match)
          )}\n` +
          `Jornada desportiva: ${match.date}\n` +
          `Canal: <#${match.channelId}>`
      );
    }

    if (
      name === 'schedule-week' ||
      name === 'edit-week'
    ) {
      const options = interaction.options;
      const editing = name === 'edit-week';
      const state = await store.read();

      const old = editing
        ? state.programs[
            options.getString('programme_id')
          ]
        : null;

      need(
        !editing ||
          (old && old.status !== 'deleted'),
        'Programa não encontrado.'
      );

      const program = old
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

      if (options.getString('titre') !== null) {
        program.title = clean(
          options.getString('titre'),
          180,
          'Título'
        );
      }

      if (options.getString('debut')) {
        program.start = dateKey(
          options.getString('debut')
        );
      }

      if (options.getString('fin')) {
        program.end = dateKey(
          options.getString('fin')
        );
      }

      need(
        Date.parse(
          program.end + 'T12:00:00Z'
        ) -
          Date.parse(
            program.start + 'T12:00:00Z'
          ) <=
          6 * 86400000,
        'O programa não pode ultrapassar sete dias.'
      );

      for (const key of Object.keys(GROUPS)) {
        if (options.getString(key) !== null) {
          const text = options
            .getString(key)
            .trim()
            .replace(/[\u2013\u2014]/g, '-');

          program.blocks[key] =
            /^(?:aucun|nenhum)$/i.test(text)
              ? ''
              : text;
        }
      }

      if (options.getChannel('reglement')) {
        program.rulesChannelId =
          options.getChannel('reglement').id;
      }

      validateProgram(program);

      if (options.getString('publication')) {
        need(
          !old?.published,
          'O anúncio já foi publicado: edita o conteúdo diretamente com este comando.'
        );

        program.publishAt = parseTime(
          options.getString('publication')
        );

        need(
          program.publishAt > Date.now(),
          'Escolhe uma publicação futura.'
        );
      }

      if (options.getChannel('channel')) {
        program.channelId =
          options.getChannel('channel').id;
      }

      program.channelId ||= interaction.channelId;

      if (options.getChannel('salon_matchs')) {
        program.matchesChannelId =
          options.getChannel('salon_matchs').id;
      }

      program.matchesChannelId ||= program.channelId;

      if (options.getString('texte') !== null) {
        program.description =
          options.getString('texte');

        program.customText = Boolean(
          program.description.trim()
        );
      }

      if (options.getString('image') !== null) {
        program.imageUrl = imageURL(
          options.getString('image')
        );
      }

      if (options.getRole('notification')) {
        program.roleId =
          options.getRole('notification').id;
      }

      if (
        editing &&
        options.getBoolean('retirer_image')
      ) {
        program.imageUrl = '';
        program.imageFile = '';
      }

      if (
        editing &&
        options.getBoolean('retirer_notification')
      ) {
        program.roleId = null;
      }

      if (
        editing &&
        options.getBoolean('retirer_texte')
      ) {
        program.description = '';
        program.customText = false;
      }

      const preview = weekCard(state, program);

      need(
        preview.embeds[0].length <= 6000,
        'O programa é demasiado longo para o Discord: encurta o texto ou a lista de jogos.'
      );

      await channel(program.channelId);
      await channel(program.matchesChannelId);

      if (
        !old ||
        program.imageUrl !== old.imageUrl
      ) {
        await cacheImage(program, store.dir);
      }

      await store.change(state => {
        if (old) {
          const latest =
            state.programs[program.id];

          need(
            latest.version === old.version,
            'O programa foi alterado. Tenta novamente.'
          );

          Object.assign(program, {
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

        program.version++;
        program.dirty = true;

        state.programs[program.id] = program;
      });

      void tick();

      return interaction.editReply(
        `✅ Programa ${
          editing ? 'atualizado' : 'criado'
        }.\n` +
          `ID: \`${program.id}\`\n` +
          `De ${program.start} a ${program.end}\n` +
          `Publicação: ${time(program.publishAt)}\n` +
          `Canal: <#${program.channelId}>\n` +
          `${programBlocks(program).length} grupos e ${
            weekMatches(state, program).length
          } jogos, independentes dos palpites.\n` +
          'Para editar os jogos: /edit-week.'
      );
    }

    const state = await store.read();

    if (name === 'close-match') {
      const id =
        interaction.options.getString('match_id');

      await store.change(state => {
        const match = getMatch(state, id);

        need(
          match.published,
          'Este jogo está agendado: utiliza /delete-match para cancelar a publicação.'
        );

        match.status = 'closed';
        match.version++;
        match.dirty = true;
      });

      void tick();

      return interaction.editReply(
        '🔒 Participações encerradas. Os palpites foram mantidos.'
      );
    }

    if (name === 'set-result') {
      const id =
        interaction.options.getString('match_id');

      const winners = [1, 2, 3].filter(number =>
        interaction.options.getBoolean(
          `choix${number}`
        )
      );

      need(
        interaction.options.getBoolean('annule') ||
          winners.length,
        'Seleciona as opções vencedoras ou annule:true se nenhuma opção ganhar.'
      );

      need(
        !interaction.options.getBoolean('annule') ||
          !winners.length,
        'Um jogo anulado não pode ter uma opção vencedora.'
      );

      await store.change(state => {
        const match = getMatch(state, id);

        need(
          match.published,
          'Este jogo ainda não foi publicado.'
        );

        need(
          Date.now() >= closeAt(match),
          'Espera pelo fecho das participações antes de registar o resultado.'
        );

        result(state, id, winners);
      });

      void tick();

      return interaction.editReply(
        '✅ Resultado registado. Os pontos são recalculados sem duplicação, mesmo em caso de correção.'
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

      const id = interaction.options.getString(
        table === 'matches'
          ? 'match_id'
          : 'programme_id'
      );

      const item = state[table][id];

      need(
        item && item.status !== 'deleted',
        'Elemento não encontrado.'
      );

      return ask(interaction, {
        kind: 'delete',
        table,
        id,
        version: item.version,
      });
    }

    if (name === 'reset-scores') {
      return ask(interaction, {
        kind: 'reset',
        fingerprint: digest({
          matches: state.matches,
          bets: state.bets,
          programs: state.programs,
        }),
      });
    }

    if (name === 'classement') {
      return interaction.editReply(
        rankCard(
          state,
          rangeOptions(interaction.options)
        )
      );
    }

    if (name === 'list-matches') {
      const date =
        interaction.options.getString('semaine');

      const start = date
        ? monday(dateKey(date))
        : null;

      const items = Object.values(state.matches)
        .filter(
          match =>
            match.status !== 'deleted' &&
            (!start ||
              (match.date >= start &&
                match.date <= shift(start, 6)))
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            closeAt(a) - closeAt(b)
        );

      const lines = items.map(
        match =>
          `${match.date} | ${match.title} | ${match.status}\n` +
          `ID: ${match.id}\n` +
          `Publicação: ${time(match.publishAt)} | Fecho: ${time(
            closeAt(match)
          )}\n`
      );

      lines.push(
        '\nPROGRAMAS\n',
        ...Object.values(state.programs)
          .filter(
            program => program.status !== 'deleted'
          )
          .map(
            program =>
              `${program.start} a ${program.end} | ${program.title}\n` +
              `ID: ${program.id}\n`
          )
      );

      return interaction.editReply({
        content:
          `${items.length} MatchDay(s). ` +
          'Os IDs também estão disponíveis no canal da equipa, se estiver configurado.',
        files: [
          new AttachmentBuilder(
            Buffer.from(
              lines.join('\n') || 'Nenhum jogo'
            ),
            { name: 'matchdays.txt' }
          ),
        ],
      });
    }

    if (name === 'diagnostic') {
      return interaction.editReply(
        `✅ Dados: ${store.file}\n` +
          `🕒 Fuso horário: ${TZ}\n` +
          `⚡ Jornada do boost: do meio-dia ao meio-dia (${TZ})\n` +
          `📅 ${
            Object.values(state.matches).filter(
              match =>
                !match.published &&
                match.status !== 'deleted' &&
                !match.missed
            ).length
          } jogos por publicar\n` +
          `📣 ${
            Object.values(state.programs).filter(
              program =>
                !program.published &&
                program.status !== 'deleted'
            ).length
          } programas por publicar\n` +
          '🏆 Sem publicação automática da classificação\n' +
          `${ICON} Unidade: ${UNIT}`
      );
    }

    if (name === 'export') {
      const range = rangeOptions(
        interaction.options
      );

      const values = rank(state, range);

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

      for (const match of Object.values(
        state.matches
      )) {
        if (
          match.status === 'deleted' ||
          (range.start &&
            match.date < range.start) ||
          (range.end && match.date > range.end)
        ) {
          continue;
        }

        for (const [id, bet] of Object.entries(
          state.bets[match.id] || {}
        )) {
          if (bet.revision !== match.revision) {
            continue;
          }

          rows.push([
            match.id,
            match.date,
            match.title,
            id,
            bet.username,
            match[`choice${bet.choice}Label`],
            bet.boosted ? 'sim' : 'não',
            earned(match, bet),
            match.result === null
              ? 'pendente'
              : match.result.join(',') || 'anulado',
          ]);
        }
      }

      const csv = value =>
        `"${String(value ?? '')
          .replaceAll('"', '""')
          .replace(/^[=+\-@]/, "'$&")}"`;

      const file = (rows, name) =>
        new AttachmentBuilder(
          Buffer.from(
            '\uFEFF' +
              rows
                .map(row => row.map(csv).join(';'))
                .join('\r\n')
          ),
          { name }
        );

      return interaction.editReply({
        content: `Export ${range.label}`,
        files: [
          file(rows, 'pronostics.csv'),
          file(
            [
              [
                'rang',
                'discord_id',
                'pseudo',
                'points',
              ],
              ...values.map((user, index) => [
                index + 1,
                user.id,
                user.name,
                user.points,
              ]),
            ],
            'classement.csv'
          ),
        ],
      });
    }
  }

  async function buttons(interaction) {
    need(
      interaction.guildId === guildId,
      'Servidor inválido.'
    );

    const privateMessage =
      interaction.message.flags.has(
        MessageFlags.Ephemeral
      );

    if (privateMessage) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    }

    let [
      ,
      action,
      matchId,
      value,
      revision,
      finalRevision,
    ] = interaction.customId.split(':');

    // Compatibilité avec les anciens boutons.
    if (
      interaction.customId.startsWith('bet_')
    ) {
      const pieces =
        interaction.customId.split('_');

      action = 'bet';
      value = pieces.pop();
      matchId = pieces.slice(1).join('_');
    }

    if (
      interaction.customId.startsWith('confirm_')
    ) {
      const pieces =
        interaction.customId.split('_');

      action = 'confirm';
      revision = pieces.pop();
      value = pieces.pop();
      matchId = pieces.slice(1).join('_');
    }

    if (
      interaction.customId === 'cancel_bet'
    ) {
      action = 'cancel';
    }

    if (action === 'cancel') {
      return interaction.editReply({
        content: 'Escolha cancelada.',
        embeds: [],
        components: [],
      });
    }

    if (
      action === 'yes' ||
      action === 'no'
    ) {
      admin(interaction);

      await store.change(state => {
        const pending =
          state.pending[matchId];

        need(
          pending &&
            pending.uid === interaction.user.id &&
            pending.expires > Date.now(),
          'Confirmação expirada. Tenta novamente.'
        );

        if (action === 'yes') {
          if (pending.kind === 'reset') {
            need(
              pending.fingerprint ===
                digest({
                  matches: state.matches,
                  bets: state.bets,
                  programs: state.programs,
                }),
              'Os dados foram alterados. Executa novamente /reset-scores.'
            );

            state.archives.push({
              at: Date.now(),
              kind: 'reset',
              matches: copy(state.matches),
              bets: copy(state.bets),
              users: copy(state.users),
              programs: copy(state.programs),
              boosts: copy(state.boosts),
            });

            for (const table of [
              'matches',
              'programs',
            ]) {
              for (const item of Object.values(
                state[table]
              )) {
                item.status = 'deleted';
                item.version++;
              }
            }

            state.users = {};
            state.bets = {};
            state.boosts = {};
          } else {
            const item =
              state[pending.table][pending.id];

            need(
              item &&
                item.version === pending.version,
              'Este elemento foi alterado. Tenta novamente.'
            );

            state.archives.push({
              at: Date.now(),
              kind: 'delete',
              table: pending.table,
              data: copy(item),
              bets:
                pending.table === 'matches'
                  ? copy(
                      state.bets[item.id] || {}
                    )
                  : undefined,
            });

            item.status = 'deleted';
            item.version++;
            item.dirty = true;

            for (const user of Object.values(
              state.users
            )) {
              user.totalPoints = 0;
            }

            for (const entry of rank(state)) {
              if (state.users[entry.id]) {
                state.users[
                  entry.id
                ].totalPoints = entry.points;
              }
            }
          }
        }

        delete state.pending[matchId];
      });

      void tick();

      return interaction.editReply({
        content:
          action === 'yes'
            ? '✅ Operação confirmada.'
            : 'Operação cancelada.',
        embeds: [],
        components: [],
      });
    }

    const state = await store.read();

    if (action === 'week') {
      const program =
        state.programs[matchId];

      need(
        program &&
          program.published &&
          program.status !== 'deleted',
        'Programa indisponível.'
      );

      return interaction.editReply(
        weekCard(state, program)
      );
    }

    if (action === 'rank') {
      const range =
        matchId === 'all'
          ? { label: 'geral' }
          : {
              start: matchId,
              end: value,
              label: `de ${matchId} a ${value}`,
            };

      return interaction.editReply(
        rankCard(state, range, revision)
      );
    }

    const match = getMatch(state, matchId);

    if (action === 'my') {
      return interaction.editReply(
        myCard(
          state,
          match,
          interaction.user.id
        )
      );
    }

    if (
      state.bets[matchId]?.[
        interaction.user.id
      ]
    ) {
      return interaction.editReply({
        content:
          '✅ O teu palpite já foi registado. Para o consultares, clica em « 📋 A minha escolha ».',
        embeds: [],
        components: [],
        allowedMentions: quiet,
      });
    }

    need(
      isOpen(match),
      'As participações estão encerradas.'
    );

    const number = Number(value);

    need(BASE[number], 'Opção inválida.');

    if (action === 'bet') {
      need(
        !revision ||
          Number(revision) === match.revision,
        'O jogo foi alterado. Utiliza a mensagem atualizada.'
      );

      const boost = boostAvailable(
        state,
        interaction.user.id
      );

      const card = embed('Confirma o teu palpite')
        .setDescription(
          [
            `**${safe(match.title)}**`,
            '',
            `${EMOJIS[number]} **${safe(
              match[
                'choice' + number + 'Label'
              ]
            )}**`,
            '',
            `${ICON} **${BASE[number]} ${UNIT}** se a tua escolha for vencedora.`,
            '',
            boost
              ? `⚡ Com o boost x2: **${
                  BASE[number] * 2
                } ${UNIT}**.`
              : 'Já utilizaste o boost desta jornada.',
            '',
            'Depois de confirmado, o teu palpite não pode ser alterado.',
          ].join('\n')
        );

      const controls = [
        button(
          `md:confirm:${matchId}:${number}:0:${match.revision}`,
          '✅ Confirmar',
          ButtonStyle.Success
        ),
      ];

      if (boost) {
        controls.push(
          button(
            `md:confirm:${matchId}:${number}:1:${match.revision}`,
            '⚡ Confirmar + Boost x2',
            ButtonStyle.Primary
          )
        );
      }

      controls.push(
        button('md:cancel', 'Cancelar')
      );

      return interaction.editReply({
        content: '',
        embeds: [card],
        components: [row(...controls)],
      });
    }

    if (action === 'confirm') {
      await store.change(state =>
        place(
          state,
          matchId,
          interaction.user.id,
          number,
          revision === '1',
          Number(
            finalRevision || match.revision
          ),
          interaction.user.username
        )
      );

      const latest = await store.read();

      return interaction.editReply(
        myCard(
          latest,
          getMatch(latest, matchId),
          interaction.user.id
        )
      );
    }
  }

  client.on(
    Events.InteractionCreate,
    async interaction => {
      if (stopping) return;

      const recognizedCommand =
        interaction.isChatInputCommand() &&
        commands.some(
          command =>
            command.name === interaction.commandName
        );

      const recognizedButton =
        interaction.isButton() &&
        /^(md:|bet_|confirm_|cancel_bet$)/.test(
          interaction.customId
        );

      if (
        !recognizedCommand &&
        !recognizedButton
      ) {
        return;
      }

      try {
        if (
          interaction.isChatInputCommand()
        ) {
          await slash(interaction);
        } else {
          await buttons(interaction);
        }
      } catch (error) {
        if (!(error instanceof UserError)) {
          log('Interação', error);
        }

        const payload = {
          content:
            error instanceof UserError
              ? `⚠️ ${error.message}`
              : 'Ocorreu um erro. Consulta os registos do bot.',
          allowedMentions: quiet,
        };

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            if (
              interaction.isButton() ||
              interaction.ephemeral
            ) {
              await interaction.editReply({
                ...payload,
                embeds: [],
                components: [],
              });
            } else {
              await interaction.followUp({
                ...payload,
                flags: MessageFlags.Ephemeral,
              });
            }
          } else {
            await interaction.reply({
              ...payload,
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch (replyError) {
          log(
            'Resposta de erro',
            replyError
          );
        }
      }
    }
  );

  client.on(
    Events.Error,
    error => log('Discord', error)
  );

  client.once(
    Events.ClientReady,
    async () => {
      try {
        const guild =
          await client.guilds.fetch(guildId);

        if (staffId) await channel(staffId);

        for (const command of commands) {
          await guild.commands.create(
            command.toJSON()
          );
        }

        const globals =
          await client.application.commands.fetch();

        for (const command of globals.values()) {
          if (
            commands.some(
              item => item.name === command.name
            )
          ) {
            await client.application.commands.delete(
              command.id
            );
          }
        }

        console.log(
          `MatchDay pronto: ${client.user.tag}. ` +
            `Fuso horário: ${TZ}. ` +
            `Dados: ${store.file}.`
        );

        await tick();

        timer = setInterval(
          () => void tick(),
          15000
        );
      } catch (error) {
        log('Inicialização', error);
        void stop(1);
      }
    }
  );

  async function stop(code = 0) {
    if (stopping) return;

    stopping = true;
    clearInterval(timer);
    client.destroy();

    await store.queue;

    process.exit(code);
  }

  process.once(
    'SIGINT',
    () => void stop()
  );

  process.once(
    'SIGTERM',
    () => void stop()
  );

  process.once(
    'uncaughtException',
    error => {
      log('Erro fatal', error);
      void stop(1);
    }
  );

  process.once(
    'unhandledRejection',
    error => {
      log('Erro fatal', error);
      void stop(1);
    }
  );

  await client.login(env.DISCORD_TOKEN);
}

if (
  require.main === module ||
  process.env.MATCHDAY_ENTRYPOINT === 'src'
) {
  run().catch(error => {
    console.error(
      `Arranque: ${
        error instanceof UserError
          ? error.message
          : error.code || error.name
      }`
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
