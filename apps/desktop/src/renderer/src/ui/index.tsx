import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import type { Task } from '../demo'

// Thin application boundary: keep Kumo interaction, accessibility, and variants intact.
export function AppButton({
  className = '',
  variant,
  ...props
}: ComponentProps<typeof Button>) {
  const classes = className.split(' ')
  const resolved =
    variant ??
    (classes.includes('primary')
      ? 'primary'
      : classes.includes('secondary')
        ? 'secondary'
        : 'ghost')
  return (
    <Button
      type="button"
      {...props}
      variant={resolved}
      className={`app-control ${className}`}
    />
  )
}
export const AppInput = forwardRef<
  HTMLInputElement,
  ComponentProps<typeof Input>
>(function AppInput(props, ref) {
  return (
    <Input
      {...props}
      ref={ref}
      className={`app-input ${props.className ?? ''}`}
    />
  )
})
const statuses = {
  进行中: 'info',
  等待反馈: 'secondary',
  待确认: 'warning',
  已完成: 'success',
} as const
export function StatusBadge({ status }: { status: Task['status'] }) {
  return (
    <Badge variant={statuses[status]} className="task-status">
      {status}
    </Badge>
  )
}
export function WorkspacePanel({ children }: { children: ReactNode }) {
  return <main className="workspace">{children}</main>
}
export function AppDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement
  }, [open])
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen && opener.current?.isConnected) opener.current.focus()
      }}
    >
      <Dialog className="app-dialog" size="lg">
        {children}
      </Dialog>
    </Dialog.Root>
  )
}
export const DialogTitle = Dialog.Title
export const DialogDescription = Dialog.Description
