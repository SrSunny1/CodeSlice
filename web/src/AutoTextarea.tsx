import { useLayoutEffect, useRef } from "react";

const MAX_H = 200;

/** 随内容自动增高的 textarea：最少一行半，超过 200px 出现滚动条。 */
export default function AutoTextarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    const h = ta.scrollHeight;
    ta.style.height = `${Math.min(h, MAX_H)}px`;
    ta.style.overflowY = h > MAX_H ? "auto" : "hidden";
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}
