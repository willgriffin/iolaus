/** Client-safe shape of the operator-configured public links. */
export interface PublicLink {
  href: string;
  label: string;
}

/** Root page data for a shared hosted deployment (no owner resume). */
export interface HostedLandingData {
  appName: string;
  links: PublicLinks;
  mode: 'landing';
  signedIn: boolean;
}

export interface PublicLinks {
  landing: PublicLink | null;
  privacy: PublicLink | null;
  support: PublicLink | null;
  terms: PublicLink | null;
}
