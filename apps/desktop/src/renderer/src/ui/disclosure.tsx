import type { ReactNode } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import './disclosure.css'

/** Native disclosure keeps hidden controls out of keyboard navigation without unmounting drafts. */
export function Disclosure({
  id,
  title,
  description,
  children,
  open,
}: {
  id?: string
  title: string
  description?: string
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
          {description && (
            <span className="disclosure-description">{description}</span>
          )}
        </span>
        <CaretRight size={16} aria-hidden="true" />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
