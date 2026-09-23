import * as React from "react"
import { resolveNumberInputStep } from "../../utils/numberInputSsot"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/**
 * Shared Input. For type="number", spinner step defaults to MONEY_INPUT_STEP (1)
 * unless the caller sets an explicit step (e.g. UoM conversion).
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", type, step, ...props }, ref) => {
    const resolvedStep = resolveNumberInputStep(type, step)

    return (
      <input
        type={type}
        step={resolvedStep}
        className={`flex w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-white file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors touch-manipulation ${className}`}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
