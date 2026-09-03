<script lang="ts">
import LinkIcon from '@lucide/svelte/icons/link';
import type {
  Achievement as AchievementItem,
  FilterState,
  Position,
  Project,
  Skill,
} from '../types';
import { type GroupMap, matches } from '../utils/filter';
import Achievement from './Achievement.svelte';
import Highlight from './Highlight.svelte';

interface Props {
  position: Position;
  skillMap: Record<string, Skill>;
  groupMap: GroupMap;
  filter: FilterState;
  toggleTag: (id: string) => void;
  search: string;
}

const { position, skillMap, groupMap, filter, toggleTag, search }: Props =
  $props();

function positionAchievements(position: Position): AchievementItem[] {
  return [
    ...position.achievements,
    ...(position.projects ?? []).flatMap((project) => project.achievements),
  ];
}

function visibleAchievementCount(achievements: AchievementItem[]): number {
  return achievements.filter((a) =>
    matches(a.tags, filter.tags, groupMap, filter.mode),
  ).length;
}

function projectDates(project: Project): string {
  return [project.start, project.end].filter(Boolean).join(' – ');
}

const visibleCount = $derived(
  visibleAchievementCount(positionAchievements(position)),
);
const dimmed = $derived(filter.tags.size > 0 && visibleCount === 0);
</script>

<article class="position" class:dimmed id={`pos-${position.id}`}>
  <div class="position-body">
    <header class="position-head">
      <div class="position-row">
        <div class="position-title">
          <h3 class="position-company">
            {#if position.companyHref}
              <a href={position.companyHref} target="_blank" rel="noopener">
                {position.company}
              </a>
            {:else}
              {position.company}
            {/if}
          </h3>
          <div class="position-role">
            {#if position.url}
              <a href={position.url} target="_blank" rel="noopener noreferrer">{position.role}</a>
            {:else}
              {position.role}
            {/if}
          </div>
        </div>
        <div class="position-dates">{position.start} – {position.end}</div>
      </div>
      {#if position.blurb}<p class="position-blurb">{position.blurb}</p>{/if}
    </header>
    {#if position.projects?.length}
      <div class="projects" aria-label={`${position.company} projects`}>
        {#each position.projects as project (project.id)}
          {@const projectVisibleCount = visibleAchievementCount(project.achievements)}
          {@const projectDimmed = filter.tags.size > 0 && projectVisibleCount === 0}
          <section class="project" class:dimmed={projectDimmed}>
            <header class="project-head">
              <div class="project-copy">
                <h4 class="project-title">
                  {#if project.url}
                    <a
                      class="project-link"
                      href={project.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span class="project-link-text">
                        <Highlight text={project.name} query={search} />
                      </span>
                      <LinkIcon
                        class="project-link-icon"
                        aria-hidden="true"
                        size={14}
                        strokeWidth={2.25}
                      />
                    </a>
                  {:else}
                    <Highlight text={project.name} query={search} />
                  {/if}
                </h4>
                {#if project.summary}
                  <p class="project-summary">
                    <Highlight text={project.summary} query={search} />
                  </p>
                {/if}
              </div>
              {#if projectDates(project)}
                <div class="project-dates">{projectDates(project)}</div>
              {/if}
            </header>
            {#if project.duties?.length}
              <ul class="project-duties">
                {#each project.duties as duty, i (duty.id ?? `${project.id}-duty-${i}`)}
                  <li>
                    {#if duty.title}<strong>{duty.title}: </strong>{/if}<Highlight
                      text={duty.body}
                      query={search}
                    />
                  </li>
                {/each}
              </ul>
            {/if}
            {#if project.achievements.length}
              <div class="project-achievements">
                {#each project.achievements as ach, i (ach.id ?? `${project.id}-achievement-${i}`)}
                  <Achievement
                    {ach}
                    {skillMap}
                    {groupMap}
                    {filter}
                    {toggleTag}
                    {search}
                  />
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
    <div class="achievements">
      {#each position.achievements as ach, i (i)}
        <Achievement {ach} {skillMap} {groupMap} {filter} {toggleTag} {search} />
      {/each}
    </div>
  </div>
</article>
