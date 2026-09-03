import type { Experience, Profile, Skills } from '../types';

export interface DetectedAI {
  api: 'LanguageModel' | 'ai.languageModel' | 'ai.assistant';
  status: string;
}

export async function detectBuiltInAI(): Promise<DetectedAI | null> {
  try {
    if (
      typeof window.LanguageModel !== 'undefined' &&
      window.LanguageModel?.availability
    ) {
      const status = await window.LanguageModel.availability();
      if (
        status === 'available' ||
        status === 'readily' ||
        status === 'downloadable' ||
        status === 'after-download'
      ) {
        return { api: 'LanguageModel', status };
      }
    }
    if (window.ai?.languageModel?.capabilities) {
      const caps = await window.ai.languageModel.capabilities();
      if (caps?.available && caps.available !== 'no') {
        return { api: 'ai.languageModel', status: caps.available };
      }
    }
    if (window.ai?.assistant?.capabilities) {
      const caps = await window.ai.assistant.capabilities();
      if (caps?.available && caps.available !== 'no') {
        return { api: 'ai.assistant', status: caps.available };
      }
    }
  } catch (e) {
    console.warn('AI detect error', e);
  }
  return null;
}

export async function createSession(
  detected: DetectedAI,
  systemPrompt: string,
): Promise<AISession> {
  if (detected.api === 'LanguageModel') {
    const languageModel = window.LanguageModel;
    if (!languageModel) throw new Error('LanguageModel API is unavailable');
    return await languageModel.create({
      initialPrompts: [{ role: 'system', content: systemPrompt }],
    });
  }
  if (detected.api === 'ai.languageModel') {
    const languageModel = window.ai?.languageModel;
    if (!languageModel) throw new Error('AI languageModel API is unavailable');
    return await languageModel.create({ systemPrompt });
  }
  if (detected.api === 'ai.assistant') {
    const assistant = window.ai?.assistant;
    if (!assistant) throw new Error('AI assistant API is unavailable');
    return await assistant.create({ systemPrompt });
  }
  throw new Error('No supported AI API');
}

export function buildSystemPrompt(
  profile: Profile,
  experience: Experience,
  skills: Skills,
): string {
  const skillIndex: Record<string, string> = {};
  for (const g of skills.groups)
    for (const s of g.skills) skillIndex[s.id] = s.label;
  const tagLabels = (tags: string[]) =>
    tags.map((t) => skillIndex[t] || t).join(', ');

  const lines: string[] = [];
  lines.push(
    `You are an interview assistant answering questions about ${profile.name}'s resume.`,
  );
  lines.push(
    `You speak in first person as if you were the candidate: friendly, confident, concise. Two or three sentences per answer unless asked for detail.`,
  );
  lines.push(
    `If a question is outside the resume scope, say you'd rather not speculate and offer to redirect.`,
  );
  lines.push('');
  lines.push('# Profile');
  lines.push(`Name: ${profile.name}`);
  lines.push(`Title: ${profile.title}`);
  lines.push(`Email: ${profile.email}`);
  lines.push(`Summary: ${profile.summary}`);
  lines.push('');
  lines.push('# Experience');
  for (const p of experience.positions) {
    lines.push(`## ${p.role} @ ${p.company} (${p.start} – ${p.end})`);
    if (p.blurb) lines.push(p.blurb);
    for (const a of p.achievements) {
      lines.push(
        `- ${a.title}: ${a.body}${a.metric ? ` [${a.metric}]` : ''} (skills: ${tagLabels(a.tags)})`,
      );
    }
    lines.push('');
  }
  lines.push('# Other Roles');
  for (const o of experience.other) {
    lines.push(
      `- ${o.role} @ ${o.company} (${o.period}): ${o.body ?? ''} (skills: ${tagLabels(o.tags || [])})`,
    );
  }
  lines.push('');
  lines.push('# Education');
  for (const e of experience.education) {
    lines.push(
      `- ${e.title}${e.institution ? ` — ${e.institution}` : ''}: ${e.detail}`,
    );
  }
  return lines.join('\n');
}
