import { z } from 'zod';

const text = z.string().trim().max(4_000);
const optionalText = z.string().trim().min(1).max(4_000).optional();
const safeUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => /^https?:\/\//iu.test(value), 'URL must use HTTP(S).');

/** Contact fields require explicit selection; resume sections are visible by default. */
export const PUBLIC_PROFILE_DEFAULT_VISIBILITY = {
  contacts: { email: false, phone: false, location: false, links: false },
  sections: { education: true, experience: true, other: true, skills: true },
} as const;

export const publicProfileVisibilitySchema = z
  .object({
    contacts: z
      .object({
        email: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.contacts.email),
        phone: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.contacts.phone),
        location: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.contacts.location),
        links: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.contacts.links),
      })
      .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.contacts),
    sections: z
      .object({
        education: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.sections.education),
        experience: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.sections.experience),
        other: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.sections.other),
        skills: z
          .boolean()
          .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.sections.skills),
      })
      .default(PUBLIC_PROFILE_DEFAULT_VISIBILITY.sections),
  })
  .strict();

const publicProjectSchema = z
  .object({ name: text, summary: text, url: safeUrl.optional() })
  .strict();

export const publicProfileSnapshotSchema = z
  .object({
    version: z.literal(1),
    name: text.min(1).max(500),
    title: text.max(500),
    summary: text.max(8_000),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().min(1).max(80).optional(),
    location: z.string().trim().min(1).max(240).optional(),
    links: z
      .array(z.object({ label: text.max(120), url: safeUrl }).strict())
      .max(30),
    experience: z
      .array(
        z
          .object({
            role: text.max(500),
            company: text.max(500),
            start: text.max(80),
            end: text.max(80),
            summary: text.optional(),
            bullets: z.array(text.max(8_000)).max(40),
            projects: z.array(publicProjectSchema).max(20),
          })
          .strict(),
      )
      .max(50),
    education: z
      .array(
        z
          .object({
            institution: text.max(500),
            credential: text.max(500),
            start: optionalText,
            end: optionalText,
            summary: optionalText,
          })
          .strict(),
      )
      .max(30),
    other: z
      .array(z.object({ label: text.max(240), value: text }).strict())
      .max(30),
    skills: z
      .array(
        z
          .object({
            label: text.max(240),
            skills: z.array(text.max(120)).max(100),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

export type PublicProfileSnapshotV1 = z.infer<
  typeof publicProfileSnapshotSchema
>;
export type PublicProfileVisibility = z.infer<
  typeof publicProfileVisibilitySchema
>;

export const publicProfileHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9-]{2,62}$/u,
    'Use 3–63 lowercase letters, digits, or hyphens.',
  )
  .refine(
    (value) => !value.includes('--'),
    'Handle cannot contain repeated hyphens.',
  )
  .refine(
    (value) => !PUBLIC_PROFILE_RESERVED_HANDLES.has(value),
    'Handle is reserved.',
  );

/** Paths and application routes which may never be claimed as a person. */
export const PUBLIC_PROFILE_RESERVED_HANDLES = new Set([
  'api',
  'admin',
  'account',
  'assets',
  'auth',
  'career',
  'favicon',
  'health',
  'jobs',
  'login',
  'logout',
  'people',
  'privacy',
  'resume',
  'robots',
  'settings',
  'signup',
  'static',
  'terms',
  'webmcp',
]);

export function normalizePublicProfileHandle(handle: string): string {
  return publicProfileHandleSchema.parse(handle);
}
