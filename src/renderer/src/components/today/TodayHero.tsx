import { Link } from 'react-router-dom'
import type { Workspace } from '@shared/types'
import { describeWeather } from '@shared/weather'
import { openExternal, useApi } from '@/lib/api'
import { greeting, useMinute } from '@/lib/clock'
import { formatLongDate, formatTemperature, formatTime, plural } from '@/lib/format'
import { Icon, type IconName } from '@/components/Icon'
import { Mark } from '@/components/Mark'

/**
 * The top of the morning.
 *
 * Today is the screen you open before you have decided anything, and for a long time
 * it opened with a date and three counts — correct, and completely anonymous. This is
 * the part that says *whose* day it is and *which* working life you are in, because
 * with three or four of them the first question of the morning is genuinely "where am
 * I". A photograph does that faster than a label does.
 *
 * Everything in here is furniture. Nothing is derived from it and nothing derives
 * from it, which is exactly why it is the one part of the app the user is allowed to
 * arrange: a banner that is wrong costs you a photograph, not an answer. What is
 * *shown* is per workspace for the same reason the banner is — the day job and your
 * own company are different rooms, and a room you have not decorated should look
 * plain rather than half-finished.
 *
 * With a banner the block is a photograph with the text laid over a scrim; without
 * one it is an ordinary panel. It is never washed in the workspace's colour: colour
 * in this app means identity, and a filled block of it would say the same thing the
 * dot beside the name already says, louder and less precisely.
 */
export function TodayHero({
  workspace,
  today,
  stats
}: {
  workspace: Workspace
  today: string
  /** Left out on a workspace with nothing in it: three zeroes are not a summary. */
  stats?: { activeProjects: number; openTasks: number; peopleTracked: number }
}): React.JSX.Element {
  const now = useMinute()
  const profile = useApi('profile:get')
  const links = useApi(
    'workspaceLink:list',
    { workspaceId: workspace.id },
    { enabled: workspace.todayShowLinks }
  )
  // Asked for only when it is wanted: the switch means no request, not a request
  // whose answer is dropped. Half an hour, because main caches it for fifteen
  // minutes and a screen left open all day should not be a poller.
  const weather = useApi(
    'weather:get',
    { workspaceId: workspace.id },
    { enabled: workspace.todayShowWeather, staleTime: 30 * 60_000, retry: false }
  )

  const name = (profile.data?.name ?? '').trim()
  const banner = workspace.banner
  const shownLinks = workspace.todayShowLinks ? (links.data ?? []) : []
  const bio = workspace.todayShowBio ? workspace.bio.trim() : ''
  const sky = workspace.todayShowWeather ? (weather.data ?? null) : null
  const hasFooter = shownLinks.length > 0 || (stats !== undefined && workspace.todayShowStats)

  /* Over a photograph everything is white and the panel's own tokens are wrong. */
  const muted = banner ? 'text-white/70' : 'text-base-content/50'
  const strong = banner ? 'text-white' : 'text-base-content'

  return (
    <section
      className={`hairline relative mb-8 overflow-hidden rounded-box border ${
        banner ? 'border-black/10' : 'bg-base-100'
      }`}
    >
      {banner && (
        <>
          <img
            src={banner}
            alt=""
            className="absolute inset-0 size-full object-cover"
            // Which part of the picture survives the crop, set by dragging it in
            // workspace settings. Centred until somebody says otherwise.
            style={{ objectPosition: `${workspace.bannerX}% ${workspace.bannerY}%` }}
          />
          {/*
            Two gradients rather than one flat wash. A single tint dark enough for the
            small print underneath makes the photograph a grey rectangle; a scrim that
            is heaviest where the words are leaves the top of the picture alone.
          */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/45 to-black/15" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/35 to-transparent" />
        </>
      )}

      <div className={`relative ${banner ? 'px-6 pb-5 pt-16' : 'px-6 py-6'}`}>
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0">
            <Link
              to="/workspace"
              className={`inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.09em] transition hover:opacity-100 ${muted} opacity-90`}
            >
              <Mark
                name={workspace.name}
                color={workspace.color}
                icon={workspace.icon}
                size={16}
                rounded="rounded-[5px]"
              />
              {workspace.name}
            </Link>

            <h1
              className={`mt-2 truncate text-[27px] font-semibold tracking-[-0.02em] ${strong} ${
                banner ? 'drop-shadow-sm' : ''
              }`}
            >
              {greeting(now)}
              {name && <span className="font-normal opacity-80">, {name}</span>}
            </h1>

            {bio && (
              <p className={`mt-1.5 max-w-xl text-[13px] leading-relaxed ${muted}`}>{bio}</p>
            )}
          </div>

          <div className="shrink-0 text-right">
            {workspace.todayShowClock && (
              <div
                className={`text-[30px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${strong}`}
              >
                {formatTime(now)}
              </div>
            )}
            <div className={`mt-1.5 text-[12px] ${muted}`}>{formatLongDate(today)}</div>
            {sky && (
              <div className={`mt-2 flex items-center justify-end gap-1.5 text-[12px] ${muted}`}>
                <Icon
                  name={describeWeather(sky.code, sky.isDay).icon as IconName}
                  size={15}
                  className={banner ? 'text-white/85' : 'text-base-content/45'}
                />
                <span className={`font-medium tabular-nums ${strong}`}>
                  {formatTemperature(sky.temperature, sky.units)}
                </span>
                {sky.description && <span>{sky.description}</span>}
                {sky.place && <span className="opacity-70">· {sky.place}</span>}
              </div>
            )}
          </div>
        </div>

        {hasFooter && (
          <div
            className={`mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t pt-4 ${
              banner ? 'border-white/20' : 'border-base-content/10'
            }`}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {shownLinks.map((link) => (
                <button
                  key={link.id}
                  onClick={() => openExternal(link.url)}
                  title={link.url}
                  className={`inline-flex max-w-[15rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                    banner
                      ? 'border-white/25 bg-white/10 text-white/90 hover:bg-white/20'
                      : 'hairline text-base-content/70 hover:bg-base-content/5'
                  }`}
                >
                  <Icon name="external" size={11} className="opacity-60" />
                  <span className="truncate">{link.label}</span>
                </button>
              ))}
            </div>

            {stats !== undefined && workspace.todayShowStats && (
              <div className={`flex flex-wrap items-center gap-x-4 text-[12px] ${muted}`}>
                <span>{plural(stats.activeProjects, 'active project')}</span>
                <span>{plural(stats.openTasks, 'open item')}</span>
                <span>{plural(stats.peopleTracked, 'person', 'people')}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
