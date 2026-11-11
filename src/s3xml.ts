// Just enough XML reading for the S3 responses this plugin consumes.
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]) : undefined;
}

export function stripEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export interface ListedObject {
  key: string;
  etag: string;
  size: number;
}

export interface ListPage {
  objects: ListedObject[];
  nextToken?: string;
}

/** Parse a ListObjectsV2 response body. */
export function parseListXml(xml: string): ListPage {
  const objects: ListedObject[] = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const key = tag(m[1], "Key");
    if (key === undefined) continue;
    objects.push({
      key,
      etag: stripEtag(tag(m[1], "ETag") ?? ""),
      size: Number(tag(m[1], "Size") ?? 0),
    });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  return { objects, nextToken: truncated ? tag(xml, "NextContinuationToken") : undefined };
}

/** Extract `<Code>: <Message>` from an S3 error body, if present. */
export function parseErrorXml(xml: string): string {
  const code = tag(xml, "Code");
  const message = tag(xml, "Message");
  return [code, message].filter(Boolean).join(": ");
}
