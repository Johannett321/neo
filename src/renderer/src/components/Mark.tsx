/**
 * The visual identity of a workspace or a project: its uploaded image if it has one,
 * otherwise its initial on a colour. Same footprint either way, so nothing reflows
 * when an icon is added or removed.
 */
export function Mark({
  name,
  color,
  icon,
  size = 22,
  rounded = 'rounded-[6px]'
}: {
  name: string
  color: string
  icon: string | null
  size?: number
  rounded?: string
}): React.JSX.Element {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        className={`shrink-0 object-cover ${rounded}`}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center font-semibold text-white ${rounded}`}
      style={{ width: size, height: size, backgroundColor: color, fontSize: size * 0.45 }}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}
