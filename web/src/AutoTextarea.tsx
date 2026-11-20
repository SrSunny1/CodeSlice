import { useLayoutEffect, useRef } from "react";

const MAX_H = 200;

interface Props extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 自动增高的上限，超过后内部滚动；默认 200px */
  maxH?: number;
}

/** 随内容自动增高的 textarea：最少一行半，超过 maxH 出现滚动条。 */
export default function AutoTextarea({ maxH = MAX_H, ...props }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    const h = ta.scrollHeight;
    ta.style.height = `${Math.min(h, maxH)}px`;
    ta.style.overflowY = h > maxH ? "auto" : "hidden";
  }, [props.value, maxH]);
  return <textarea ref={ref} {...props} />;
}
