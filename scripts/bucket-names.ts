export function bucketToStem(name: string): string {
    return name.trim().replace(/\s+/g, "_");
}

export function bucketToFilename(name: string): string {
    return `${bucketToStem(name)}.md`;
}

export function canonicalBucketKey(name: string): string {
    return name.trim().toLowerCase().replace(/[\s_]+/g, "_");
}
