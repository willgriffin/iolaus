<script lang="ts">
import { AssistantDock } from '@happyvertical/smrt-chat/svelte';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import X from '@lucide/svelte/icons/x';
import { createAdminAssistantTransport } from '$lib/admin/assistant-transport';

let { visible, onClose }: { visible: boolean; onClose: () => void } = $props();
const transport = createAdminAssistantTransport();
// Plain chat has no mutation client or browser tools. The server owns its capabilities.
const registry = createDataSurfaceRegistry();
</script>
<section id="admin-assistant" class="assistant-panel" aria-label="Assistant">
  <header><strong>Assistant</strong><button type="button" aria-label="Close assistant" onclick={onClose}><X size={18} aria-hidden="true" /></button></header>
  <div class="assistant-chat"><AssistantDock {transport} {registry} {visible} composerPlaceholder="Ask the assistant…" /></div>
</section>
<style>
.assistant-panel { display:flex; flex-direction:column; height:100%; min-height:0; }
header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
header button { display:grid; place-items:center; width:44px; height:44px; border:0; border-radius:7px; background:transparent; color:var(--smrt-color-on-surface); cursor:pointer; }
header button:focus-visible { outline:2px solid var(--smrt-color-on-surface); outline-offset:2px; }
.assistant-chat { flex:1; min-height:0; overflow:auto; }
</style>
