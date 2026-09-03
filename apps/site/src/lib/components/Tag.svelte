<script lang="ts">
interface Props {
  label: string;
  active: boolean;
  onclick: () => void;
}

const { label, active, onclick }: Props = $props();
</script>

<button class="tag" class:active {onclick} title={`Filter by ${label}`}>
  {label}
</button>
