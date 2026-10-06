<script lang="ts">
import { Combobox, MultiSelect, Select } from '@happyvertical/smrt-ui/forms';
import { untrack } from 'svelte';
import { enhance } from '$app/forms';
import { keepFormValues } from '$lib/admin/form-enhance';

let { data, form } = $props();

function preferences(): Record<string, string | string[]> {
  try {
    return JSON.parse(data.profile?.preferencesJson || '{}');
  } catch {
    return {};
  }
}

const savedPreferences = preferences();
const stringList = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join(', ') : value || '';

function countryCode(value: string | undefined): string {
  try {
    const parsed = JSON.parse(value || '{}') as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : '';
  } catch {
    return '';
  }
}

function countryCodes(
  value: string | undefined,
  authorization = false,
): string {
  try {
    const parsed = JSON.parse(value || '[]') as unknown[];
    return parsed
      .map((entry) => {
        const record = entry as {
          code?: unknown;
          country?: { code?: unknown };
          scope?: unknown;
          condition?: unknown;
        };
        if (
          authorization &&
          (record.scope !== 'country' ||
            (typeof record.condition === 'string' && record.condition.trim()))
        )
          return '';
        const code = authorization ? record.country?.code : record.code;
        return typeof code === 'string' ? code : '';
      })
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
}

const initialProfile = untrack(() => data.profile);
const savedEligibility = initialProfile?.basicWorkEligibility;
let citizenshipCodes = $state<Array<string | number>>(
  savedEligibility?.citizenshipCountryCodes ??
    countryCodes(initialProfile?.citizenshipsJson).split(', ').filter(Boolean),
);
let otherAuthorizedCodes = $state<Array<string | number>>(
  savedEligibility?.otherAuthorizedCountryCodes ?? [],
);
let citizenshipSearch = $state('');
let otherCountrySearch = $state('');
let canWorkElsewhere = $state(savedEligibility?.canWorkElsewhere ?? 'unknown');
let advancedCountryEdits = $state(false);
let selectedRoles = $state(
  Array.isArray(savedPreferences.targetRoles)
    ? savedPreferences.targetRoles.filter(Boolean)
    : stringList(savedPreferences.targetRoles)
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
);
let roleDraft = $state('');

const roleSuggestions = [
  'Software Engineer',
  'Senior Software Engineer',
  'Staff Software Engineer',
  'Principal Software Engineer',
  'Engineering Manager',
  'Technical Lead',
  'AI Engineer',
  'Machine Learning Engineer',
  'Data Engineer',
  'Solutions Architect',
  'Software Architect',
  'Platform Engineer',
].map((label) => ({ value: label, label }));

const countryOptions = $derived(data.countryOptions ?? []);
const citizenshipOptions = $derived(
  countryOptions.filter(
    (option) =>
      citizenshipCodes.includes(option.value) ||
      `${option.label} ${option.value}`
        .toLowerCase()
        .includes(citizenshipSearch.trim().toLowerCase()),
  ),
);
const otherCountryOptions = $derived(
  countryOptions.filter(
    (option) =>
      otherAuthorizedCodes.includes(option.value) ||
      `${option.label} ${option.value}`
        .toLowerCase()
        .includes(otherCountrySearch.trim().toLowerCase()),
  ),
);
const submittedRoles = $derived([
  ...new Set([...selectedRoles, roleDraft.trim()].filter(Boolean)),
]);

function addRole() {
  const role = roleDraft.trim();
  if (
    role &&
    !selectedRoles.some((saved) => saved.toLowerCase() === role.toLowerCase())
  ) {
    selectedRoles = [...selectedRoles, role];
  }
  roleDraft = '';
}
</script>

<svelte:head>
  <title>Set up your job search — Iolaus</title>
</svelte:head>

<main class="onboarding-shell">
  <header>
    <p class="eyebrow">Private setup</p>
    <h1>Tell Iolaus what it can safely reuse.</h1>
    <p>
      Your profile stays in your local data store. Iolaus asks when a fact is
      missing and never treats a role-specific answer as reusable unless you
      explicitly save it.
    </p>
  </header>

  {#if form?.error}
    <p class="notice error" role="alert">{form.error}</p>
  {:else if form?.saved}
    <p class="notice success" role="status">
      Saved private onboarding data{form.savedForReuse ? ` and ${form.savedForReuse} reusable answer${form.savedForReuse === 1 ? '' : 's'}` : ''}.
    </p>
  {:else if form?.revoked}
    <p class="notice success" role="status">Removed that answer from future reuse.</p>
  {/if}

  <form use:enhance={keepFormValues} method="POST" action="?/save" class="onboarding-form">
    <section>
      <h2>Contact and location</h2>
      <div class="grid two">
        <label>Display name <input name="name" value={data.profile?.name ?? ''} autocomplete="name" /></label>
        <label>First name <input name="firstName" value={data.profile?.firstName ?? ''} autocomplete="given-name" /></label>
        <label>Last name <input name="lastName" value={data.profile?.lastName ?? ''} autocomplete="family-name" /></label>
        <label>Email <input name="email" type="email" value={data.profile?.email ?? ''} autocomplete="email" /></label>
        <label>Phone <input name="phone" type="tel" value={data.profile?.phone ?? ''} autocomplete="tel" /></label>
        <label>Current location <input name="location" value={data.profile?.location ?? ''} autocomplete="address-level2" /></label>
      </div>
      <div class="grid two">
        <label>LinkedIn URL <input name="linkedinUrl" type="url" value={data.profile?.linkedinUrl ?? ''} /></label>
        <label>GitHub URL <input name="githubUrl" type="url" value={data.profile?.githubUrl ?? ''} /></label>
      </div>
    </section>

    <section>
      <h2>Citizenship and work eligibility</h2>
      <p>Select your citizenship countries, then confirm where you can work. Citizenship alone does not confirm work authorization, and not having a visa elsewhere does not mean you need sponsorship at home.</p>
      <input type="hidden" name="onboardingMode" value="basic" />
      <div class="grid two">
        <div class="country-field">
          <label for="citizenship-search">Find a citizenship country</label>
          <input id="citizenship-search" type="search" bind:value={citizenshipSearch} placeholder="Search countries" autocomplete="off" />
          <MultiSelect label="I’m a citizen of" options={citizenshipOptions} bind:values={citizenshipCodes} placeholder="Choose countries" class="country-picker" />
          {#each citizenshipCodes as code (code)}
            <input type="hidden" name="citizenshipCountryCodes" value={String(code)} />
          {/each}
        </div>
        <label>Can you work in those countries without employer sponsorship?
          <Select name="citizenshipWorkAuthorization" value={savedEligibility?.citizenshipWorkAuthorization ?? 'unknown'}>
            <option value="unknown">I’m not sure</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </label>
        <label>Can you work in any other countries without employer sponsorship?
          <Select name="canWorkElsewhere" bind:value={canWorkElsewhere}>
            <option value="unknown">I’m not sure</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </label>
        <label>Do you need an employer to sponsor a work visa?
          <Select name="sponsorshipRequired" value={data.profile?.sponsorshipRequired === true ? 'yes' : data.profile?.sponsorshipRequired === false ? 'no' : 'unknown'}>
            <option value="unknown">I’m not sure</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </label>
      </div>
      {#if canWorkElsewhere === 'yes'}
        <div class="country-field other-countries">
          <label for="other-country-search">Find other countries where you can work</label>
          <input id="other-country-search" type="search" bind:value={otherCountrySearch} placeholder="Search countries" autocomplete="off" />
          <MultiSelect label="I can work in" options={otherCountryOptions} bind:values={otherAuthorizedCodes} placeholder="Choose countries" class="country-picker" />
          {#each otherAuthorizedCodes as code (code)}
            <input type="hidden" name="otherAuthorizedCountryCodes" value={String(code)} />
          {/each}
        </div>
      {/if}
      {#if savedEligibility?.conflicts?.length}
        <p class="field-note" role="note">Some saved work rights need a closer look. Open advanced details before changing them: {savedEligibility.conflicts.join('; ')}.</p>
      {/if}
      <details bind:open={advancedCountryEdits} class="advanced-details">
        <summary>Advanced country and authorization details</summary>
        {#if advancedCountryEdits}
          <input type="hidden" name="advancedCountryEdits" value="1" />
        {/if}
        <fieldset disabled={!advancedCountryEdits}>
          <p>Use these fields only to update details that need a more precise explanation. Existing details stay saved when this section is closed.</p>
          <div class="grid two">
            <label>Residence country code <input name="residenceCountry" value={countryCode(data.profile?.residenceCountryJson)} placeholder="CA" autocapitalize="characters" /></label>
            <label>Target work country code <input name="targetWorkCountry" value={countryCode(data.profile?.targetWorkCountryJson)} placeholder="CA" autocapitalize="characters" /></label>
            <label>Work authorization details <input name="workAuthorization" value={data.profile?.workAuthorization ?? ''} placeholder="For example, employer-limited permit" /></label>
            <label>Verified unrestricted work countries <input name="authorizedWorkCountries" value={countryCodes(data.profile?.authorizedWorkCountriesJson, true)} placeholder="CA" autocapitalize="characters" /></label>
          </div>
          <p class="field-note">Only list unrestricted, verified work rights. Conditional or employer-limited rights need their own evidence.</p>
        </fieldset>
      </details>
    </section>

    <section>
      <h2>Career preferences</h2>
      <div class="grid two">
        <label>Professional title <input name="title" value={data.profile?.title ?? ''} placeholder="Staff software engineer" /></label>
        <label>Target compensation <input name="targetCompensation" value={stringList(savedPreferences.targetCompensation)} placeholder="For example, CAD 180k+ depending on role" /></label>
        <div class="role-field">
          <Combobox label="Target roles" options={roleSuggestions} bind:value={roleDraft} allowCustom placeholder="Search or enter a role" />
          <button type="button" class="secondary add-role" onclick={addRole}>Add role</button>
          {#if selectedRoles.length}
            <ul class="role-list" aria-label="Selected target roles">
              {#each selectedRoles as role (role)}
                <li>{role} <button type="button" class="remove-role" aria-label={`Remove ${role}`} onclick={() => selectedRoles = selectedRoles.filter((saved) => saved !== role)}>×</button></li>
              {/each}
            </ul>
          {/if}
          <input type="hidden" name="targetRoles" value={submittedRoles.join(', ')} />
        </div>
        <label>Preferred work mode
          <Select name="workModeChoice" value={savedEligibility?.workModeChoice ?? 'unknown'}>
            <option value="unknown">I’m not sure</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On site</option>
            <option value="any">Any</option>
          </Select>
        </label>
        <label>Preferred locations <input name="preferredLocations" value={stringList(savedPreferences.locations)} placeholder="Comma-separated" /></label>
      </div>
      <label>Professional summary <textarea name="summary" rows="4">{data.profile?.summary ?? ''}</textarea></label>
    </section>

    <section>
      <h2>Resume source</h2>
      <p>Select an existing resume asset, or save this setup and add one later. Asset files remain below your local Iolaus data root.</p>
      <label>Resume asset
        <select name="resumeAssetId">
          <option value="">Choose later</option>
          {#each data.resumeAssets as asset (asset.id)}
            <option value={asset.id} selected={asset.id === data.profile?.resumeAssetId}>
              {asset.title || asset.pdfBasename || asset.id} {asset.status ? `(${asset.status})` : ''}
            </option>
          {/each}
        </select>
      </label>
      <label class="checkbox"><input type="checkbox" name="resumeSource" value="upload_later" checked={data.profile?.resumeSource === 'upload_later'} /> I will add a resume later</label>
    </section>

    <section>
      <h2>One reusable answer</h2>
      <p>Only checked answers are available to future applications. You can revoke them below at any time.</p>
      <div class="grid two">
        <label>Question label <input name="reusableAnswerLabel" placeholder="For example, Work authorization" /></label>
        <label>Answer <input name="reusableAnswerValue" /></label>
      </div>
      <label class="checkbox"><input type="checkbox" name="saveReusableAnswer" /> Save this answer for future applications</label>
    </section>

    <section>
      <h2>Voluntary demographics</h2>
      <p>Optional. These answers stay private and are not exposed through general agent reads.</p>
      <div class="grid two">
        <label>Race or ethnicity <input name="demographicRaceOrEthnicity" value={data.profile?.demographics?.raceOrEthnicity ?? ''} /></label>
        <label>Gender <input name="demographicGender" value={data.profile?.demographics?.gender ?? ''} /></label>
        <label>Veteran status <input name="demographicVeteranStatus" value={data.profile?.demographics?.veteranStatus ?? ''} /></label>
        <label>Disability status <input name="demographicDisability" value={data.profile?.demographics?.disability ?? ''} /></label>
      </div>
      <label class="checkbox"><input type="checkbox" name="saveVoluntaryDemographics" checked={data.profile?.demographicsConsent ?? false} /> I choose to save these voluntary demographics locally</label>
    </section>

    <button type="submit">Save private setup</button>
  </form>

  {#if data.reusableAnswers.length}
    <section class="saved-answers" aria-label="Saved reusable answers">
      <h2>Saved reusable answers</h2>
      {#each data.reusableAnswers as answer (answer.id)}
        <form use:enhance method="POST" action="?/revokeReusableAnswer">
          <div><strong>{answer.label}</strong><span>{answer.value}</span></div>
          <input type="hidden" name="labelKey" value={answer.labelKey} />
          <button type="submit" class="secondary">Stop reusing</button>
        </form>
      {/each}
    </section>
  {/if}
</main>

<style>
  .onboarding-shell { max-width: 880px; margin: 0 auto; padding: 40px 24px 72px; color: var(--smrt-color-on-surface); color-scheme: var(--smrt-color-scheme, light); }
  header { max-width: 680px; margin-bottom: 28px; }
  .eyebrow { color: var(--smrt-color-on-surface-variant); font: 700 12px/1.2 var(--smrt-font-family-mono, monospace); letter-spacing: .08em; text-transform: uppercase; }
  h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.06; margin: 8px 0 14px; }
  h2 { margin: 0 0 8px; font-size: 20px; }
  p { line-height: 1.5; color: var(--smrt-color-on-surface-variant); }
  .onboarding-form { display: grid; gap: 18px; }
  section { border: 1px solid var(--smrt-color-outline-variant); border-radius: 8px; padding: 20px; background: var(--smrt-color-surface-container-low); }
  .grid { display: grid; gap: 14px; margin-top: 14px; }
  .field-note { grid-column: 1 / -1; margin: -4px 0 0; font-size: 13px; }
  .country-field, .role-field { display: grid; align-content: start; gap: 8px; }
  .role-field { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
  .role-list { grid-column: 1 / -1; }
  .other-countries { max-width: 450px; margin-top: 16px; }
  :global(.country-picker .options) { max-height: 280px; overflow-y: auto; }
  .advanced-details { margin-top: 18px; border-top: 1px solid var(--smrt-color-outline-variant); padding-top: 14px; }
  summary { color: var(--smrt-color-primary); cursor: pointer; font-weight: 700; }
  fieldset { min-width: 0; margin: 10px 0 0; padding: 0; border: 0; }
  .add-role { padding: 7px 11px; }
  .role-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .role-list li { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; border: 1px solid var(--smrt-color-outline-variant); border-radius: 20px; background: var(--smrt-color-surface-container); color: var(--smrt-color-on-surface); padding: 3px 6px 3px 10px; overflow-wrap: anywhere; }
  .role-list .remove-role { border: 0; background: transparent; color: var(--smrt-color-on-surface); padding: 0 4px; }
  .two { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
  label { display: grid; gap: 6px; font-size: 14px; font-weight: 650; }
  input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid var(--smrt-color-outline-variant); border-radius: 5px; background: var(--smrt-color-surface-container-lowest); color: var(--smrt-color-on-surface); font: inherit; padding: 9px 10px; }
  input::placeholder, textarea::placeholder { color: var(--smrt-color-on-surface-variant); opacity: 1; }
  input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  textarea { resize: vertical; }
  .checkbox { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-weight: 500; }
  .checkbox input { width: auto; accent-color: var(--smrt-color-primary); }
  button { justify-self: start; border: 1px solid var(--smrt-color-primary); border-radius: 6px; background: var(--smrt-color-primary); color: var(--smrt-color-on-primary); cursor: pointer; font: inherit; font-weight: 700; padding: 10px 15px; }
  button.secondary { background: var(--smrt-color-surface-container-lowest); color: var(--smrt-color-on-surface); border-color: var(--smrt-color-outline-variant); }
  .notice { border-radius: 6px; padding: 12px 14px; }
  .notice.success { background: var(--smrt-color-success-container); color: var(--smrt-color-on-success-container); }
  .notice.error { background: var(--smrt-color-error-container); color: var(--smrt-color-on-error-container); }
  .saved-answers { margin-top: 24px; }
  .saved-answers form { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--smrt-color-outline-variant); }
  .saved-answers form:first-of-type { border-top: 0; }
  .saved-answers div { display: grid; gap: 3px; }
  .saved-answers span { color: var(--smrt-color-on-surface-variant); overflow-wrap: anywhere; }
</style>
