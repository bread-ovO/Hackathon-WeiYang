import type { ReactNode } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import './disclosure.css'
import { HelpTip } from './help-tip'

/** Native disclosure keeps hidden controls out of keyboard navigation without unmounting drafts. */
export function Disclosure({
  id,
  title,
  description,
  descriptionAsHelp = false,
  children,
  open,
}: {
  id?: string
  title: string
  description?: string
  descriptionAsHelp?: boolean
  children: ReactNode
  open?: boolean
}) {
  return (
    <details
      id={id}
      className="disclosure"
      open={open}
      onToggle={(event) => {
        const element = event.currentTarget
        if (
          !element.open &&
          document.activeElement === element.querySelector('summary') &&
          id
        )
          document
            .getElementById(`${id}-trigger`)
            ?.focus({ preventScroll: true })
      }}
    >
      <summary>
        <span className="disclosure-copy">
          <span className="disclosure-title">{title}</span>
          {description && !descriptionAsHelp && (
            <span className="disclosure-description">{description}</span>
          )}
        </span>
        <span className="disclosure-tools">
          {description && descriptionAsHelp && <HelpTip label={`${title}说明`}>{description}</HelpTip>}
          <CaretRight size={16} aria-hidden="true" />
        </span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
