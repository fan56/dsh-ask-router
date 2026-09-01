/**
 * dsh-ask-router — interaction routing for ask-user questions.
 *
 * Targets the dsh 0.1.2-alpha host line only (the rc-era single-provider slot
 * this plugin used to own is gone — alpha.3 removed `registerProvider` along
 * with its DUPLICATE_PROVIDER protocol): answerers compose on the scoped
 * 'user-questions/request' cordis waterfall, where a listener answers by
 * returning a value and delegates by calling `next()`. This plugin registers
 * as one waterfall answerer.
 *
 * The plugin provides `ctx.askSurfaces`, a registry where UIs register as
 * surfaces with a `claim(request)` predicate ("the asking session is mine");
 * on ask it fans the question out to every claiming surface (when nobody
 * claims, to every registered surface — visible somewhere beats failing),
 * and the FIRST completed answer wins; every other surface gets
 * `settled(request, winnerName)` so it can dismiss its UI; an aborted ask
 * rejects everywhere (surfaces also observe the request's own signal).
 *
 * Coexistence is the point: UIs answer side by side on the waterfall, so the
 * router can even multiplex for a web profile; with zero surfaces it
 * delegates via next().
 */

import { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

/** One interaction surface able to render and answer ask-user questions. */
export interface AskSurface {
  /** Stable display name (used in "answered on X" notices). */
  readonly name: string
  /** Whether this surface currently drives the asking agent's session. */
  claim(request: AskUserQuestionRequest): boolean
  /** Render the question and resolve with the human's answer. */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  /** Another surface answered first — dismiss the rendered question. */
  settled?(request: AskUserQuestionRequest, by: string): void
}

/** The registry surface UIs register against (ctx.get('askSurfaces')). */
export interface AskSurfaces {
  register(surface: AskSurface): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    askSurfaces: AskSurfaceRegistry
  }
}

/**
 * Plain registry (no Service base — trivially unit-testable); apply()
 * provides it under `askSurfaces` so surfaces find it via ctx.get().
 */
export class AskSurfaceRegistry {
  private readonly surfaces: AskSurface[] = []

  register(surface: AskSurface): () => void {
    this.surfaces.push(surface)
    return () => {
      const index = this.surfaces.indexOf(surface)
      if (index >= 0) this.surfaces.splice(index, 1)
    }
  }

  /** Snapshot of the registered surfaces in registration order. */
  list(): readonly AskSurface[] {
    return [...this.surfaces]
  }
}

/** claim() guarded: a throwing surface claims nothing. */
function safeClaim(surface: AskSurface, request: AskUserQuestionRequest): boolean {
  try {
    return surface.claim(request) === true
  } catch {
    return false
  }
}

/** settled() guarded: a throwing dismissal never breaks the winner. */
function safeSettled(surface: AskSurface, request: AskUserQuestionRequest, by: string): void {
  try {
    surface.settled?.(request, by)
  } catch {
    // contained — the losing surface's cleanup is best-effort
  }
}

/**
 * Route one ask: fan out to the claiming surfaces (all registered when
 * nobody claims), first answer wins, losers get settled(). Resolves the
 * outer promise exactly once; failures only reject when EVERY target failed.
 */
export function routeAsk(surfaces: readonly AskSurface[], request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
    if (surfaces.length === 0) {
      reject(new UserQuestionError('no ask surface is registered in this process', 'NO_PROVIDER'))
      return
    }
    const claimants = surfaces.filter(surface => safeClaim(surface, request))
    const targets = claimants.length > 0 ? claimants : surfaces
    let settled = false
    const failures: unknown[] = []
    for (const surface of targets) {
      Promise.resolve()
        .then(() => surface.ask(request))
        .then(answer => {
          if (settled) return
          settled = true
          for (const other of targets) {
            if (other !== surface) safeSettled(other, request, surface.name)
          }
          resolve(answer)
        }, error => {
          if (settled) return
          failures.push(error)
          if (failures.length >= targets.length) {
            settled = true
            reject(failures[0] instanceof Error
              ? failures[0]
              : new UserQuestionError('every ask surface failed', 'NO_ANSWER'))
          }
        })
    }
    request.signal?.addEventListener('abort', () => {
      if (settled) return
      settled = true
      reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }, { once: true })
  })
}

export const inject = ['userQuestions']

/** The 'user-questions/request' cordis waterfall seam. */
interface UserQuestionsWaterfallSeam {
  on(
    event: 'user-questions/request',
    listener: (
      request: AskUserQuestionRequest,
      next: () => Promise<AskUserQuestionAnswer>,
    ) => Promise<AskUserQuestionAnswer>,
  ): () => boolean
}

export function apply(ctx: Context): void {
  const registry = new AskSurfaceRegistry()
  ctx.provide('askSurfaces', registry)
  const route = (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => routeAsk(registry.list(), request)
  // Answerers compose on the Agent-scoped 'user-questions/request' cordis
  // waterfall (dsh 0.1.2-alpha.3 removed the rc-era single-provider slot and
  // its DUPLICATE_PROVIDER protocol): answer by returning, delegate with
  // next(). Surfaces fan out as before; with zero surfaces, step aside so a
  // co-present native answerer (e.g. the web UI) serves, or the request
  // fails NO_PROVIDER upstream.
  const waterfall = ctx as unknown as UserQuestionsWaterfallSeam
  const dispose = waterfall.on('user-questions/request', (request, next) => {
    const surfaces = registry.list()
    return surfaces.length === 0 ? next() : routeAsk(surfaces, request)
  })
  ctx.effect(() => dispose)
}
