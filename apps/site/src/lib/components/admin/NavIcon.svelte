<script lang="ts">
import Bot from '@lucide/svelte/icons/bot';
import BriefcaseBusiness from '@lucide/svelte/icons/briefcase-business';
import Building2 from '@lucide/svelte/icons/building-2';
import ChartBar from '@lucide/svelte/icons/chart-bar';
import Database from '@lucide/svelte/icons/database';
import FileText from '@lucide/svelte/icons/file-text';
import FolderTree from '@lucide/svelte/icons/folder-tree';
import Gavel from '@lucide/svelte/icons/gavel';
import Home from '@lucide/svelte/icons/house';
import Layers from '@lucide/svelte/icons/layers';
import MapPin from '@lucide/svelte/icons/map-pin';
import Pencil from '@lucide/svelte/icons/pencil';
import Plus from '@lucide/svelte/icons/plus';
import Rocket from '@lucide/svelte/icons/rocket';
import Rss from '@lucide/svelte/icons/rss';
import Send from '@lucide/svelte/icons/send';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import CheckSquare from '@lucide/svelte/icons/square-check-big';
import Tag from '@lucide/svelte/icons/tag';
import Users from '@lucide/svelte/icons/users';

let { name, size = 16 } = $props<{ name: string; size?: number }>();

const icons = {
  briefcase: BriefcaseBusiness,
  building: Building2,
  bot: Bot,
  'bar-chart': ChartBar,
  'check-square': CheckSquare,
  database: Database,
  'file-text': FileText,
  'folder-tree': FolderTree,
  gavel: Gavel,
  home: Home,
  layers: Layers,
  'map-pin': MapPin,
  pencil: Pencil,
  plus: Plus,
  rocket: Rocket,
  rss: Rss,
  send: Send,
  sliders: SlidersHorizontal,
  tag: Tag,
  users: Users,
};

const Icon = $derived(icons[name as keyof typeof icons] ?? Database);
</script>

<Icon {size} strokeWidth={2.1} />
