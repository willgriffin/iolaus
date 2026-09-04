<script lang="ts">
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

  <form method="POST" action="?/save" class="onboarding-form">
    <section>
      <h2>Contact and location</h2>
      <div class="grid two">
        <label>Display name <input name="name" value={data.profile?.name ?? ''} autocomplete="name" /></label>
        <label>First name <input name="firstName" value={data.profile?.firstName ?? ''} autocomplete="given-name" /></label>
        <label>Last name <input name="lastName" value={data.profile?.lastName ?? ''} autocomplete="family-name" /></label>
        <label>Email <input name="email" type="email" value={data.profile?.email ?? ''} autocomplete="email" /></label>
        <label>Phone <input name="phone" type="tel" value={data.profile?.phone ?? ''} autocomplete="tel" /></label>
        <label>Current location <input name="location" value={data.profile?.location ?? ''} autocomplete="address-level2" /></label>
        <label>Work authorization <input name="workAuthorization" value={data.profile?.workAuthorization ?? ''} placeholder="For example, eligible to work in Canada" /></label>
      </div>
      <div class="grid two">
        <label>LinkedIn URL <input name="linkedinUrl" type="url" value={data.profile?.linkedinUrl ?? ''} /></label>
        <label>GitHub URL <input name="githubUrl" type="url" value={data.profile?.githubUrl ?? ''} /></label>
      </div>
    </section>

    <section>
      <h2>Career preferences</h2>
      <div class="grid two">
        <label>Professional title <input name="title" value={data.profile?.title ?? ''} placeholder="Staff software engineer" /></label>
        <label>Target compensation <input name="targetCompensation" value={stringList(savedPreferences.targetCompensation)} placeholder="For example, CAD 180k+ depending on role" /></label>
        <label>Target roles <input name="targetRoles" value={stringList(savedPreferences.targetRoles)} placeholder="Comma-separated" /></label>
        <label>Preferred work modes <input name="workModes" value={stringList(savedPreferences.workModes)} placeholder="remote, hybrid" /></label>
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
        <form method="POST" action="?/revokeReusableAnswer">
          <div><strong>{answer.label}</strong><span>{answer.value}</span></div>
          <input type="hidden" name="labelKey" value={answer.labelKey} />
          <button type="submit" class="secondary">Stop reusing</button>
        </form>
      {/each}
    </section>
  {/if}
</main>

<style>
  .onboarding-shell { max-width: 880px; margin: 0 auto; padding: 40px 24px 72px; color: var(--smrt-color-foreground, #1d1b18); }
  header { max-width: 680px; margin-bottom: 28px; }
  .eyebrow { color: #756d60; font: 700 12px/1.2 var(--font-mono, monospace); letter-spacing: .08em; text-transform: uppercase; }
  h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.06; margin: 8px 0 14px; }
  h2 { margin: 0 0 8px; font-size: 20px; }
  p { line-height: 1.5; color: #625c52; }
  .onboarding-form { display: grid; gap: 18px; }
  section { border: 1px solid #ded8ca; border-radius: 8px; padding: 20px; background: #fffdf9; }
  .grid { display: grid; gap: 14px; margin-top: 14px; }
  .two { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
  label { display: grid; gap: 6px; font-size: 14px; font-weight: 650; }
  input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #bcb4a7; border-radius: 5px; background: #fff; color: inherit; font: inherit; padding: 9px 10px; }
  textarea { resize: vertical; }
  .checkbox { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-weight: 500; }
  .checkbox input { width: auto; }
  button { justify-self: start; border: 1px solid #1f1d1a; border-radius: 6px; background: #1f1d1a; color: #fff; cursor: pointer; font: inherit; font-weight: 700; padding: 10px 15px; }
  button.secondary { background: #fff; color: #3f3a33; border-color: #bcb4a7; }
  .notice { border-radius: 6px; padding: 12px 14px; }
  .notice.success { background: #e7f4eb; color: #204d2d; }
  .notice.error { background: #fce9e6; color: #852b1d; }
  .saved-answers { margin-top: 24px; }
  .saved-answers form { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid #e5dfd5; }
  .saved-answers form:first-of-type { border-top: 0; }
  .saved-answers div { display: grid; gap: 3px; }
  .saved-answers span { color: #625c52; overflow-wrap: anywhere; }
</style>
