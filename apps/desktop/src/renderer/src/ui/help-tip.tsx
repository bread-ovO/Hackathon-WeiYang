import { useId, type ReactNode } from 'react'
import { QuestionIcon } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo/components/tooltip'
import './help-tip.css'

/** Explanatory copy on hover or keyboard focus; never toggles its parent disclosure. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return <Tooltip content={<span id={id} role="tooltip" className="help-tip-content">{children}</span>} render={
    <button type="button" className="help-tip" aria-label={label} aria-describedby={id}
      onClick={event => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>
      <QuestionIcon size={16} aria-hidden="true" />
    </button>
  } />
}
