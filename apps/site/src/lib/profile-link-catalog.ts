export type ProfileLinkProvider = {
  id: string;
  label: string;
  hosts?: readonly string[];
  aliases?: readonly string[];
};
export const PROFILE_LINK_PROVIDERS: readonly ProfileLinkProvider[] = [
  {
    id: 'linkedin',
    label: 'LinkedIn',
    hosts: ['linkedin.com', 'www.linkedin.com'],
  },
  {
    id: 'github',
    label: 'GitHub',
    hosts: ['github.com', 'www.github.com'],
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    hosts: ['gitlab.com', 'www.gitlab.com'],
  },
  {
    id: 'stackoverflow',
    label: 'Stack Overflow',
    hosts: ['stackoverflow.com', 'www.stackoverflow.com'],
  },
  {
    id: 'behance',
    label: 'Behance',
    hosts: ['behance.net', 'www.behance.net'],
  },
  {
    id: 'dribbble',
    label: 'Dribbble',
    hosts: ['dribbble.com', 'www.dribbble.com'],
  },
  {
    id: 'youtube',
    label: 'YouTube',
    hosts: ['youtube.com', 'www.youtube.com', 'youtu.be'],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    hosts: ['instagram.com', 'www.instagram.com'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    hosts: ['facebook.com', 'www.facebook.com'],
  },
  {
    id: 'x',
    label: 'X',
    hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    hosts: ['bsky.app', 'www.bsky.app'],
  },
  {
    id: 'website',
    label: 'Website / portfolio',
    aliases: ['website', 'portfolio', 'personal website'],
  },
] as const;
export function providerForLink(link: { href?: unknown; label?: unknown }) {
  const label =
    typeof link.label === 'string' ? link.label.trim().toLowerCase() : '';
  let hostname = '';
  try {
    hostname = new URL(
      typeof link.href === 'string' ? link.href : '',
    ).hostname.toLowerCase();
  } catch {
    /* custom links remain custom */
  }
  return PROFILE_LINK_PROVIDERS.find(
    (provider) =>
      (provider.hosts?.includes(hostname) ?? false) ||
      (provider.aliases?.includes(label) ?? false),
  );
}
