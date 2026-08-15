declare module 'word-extractor' {
  interface ExtractedWordDocument {
    getBody(): string
  }

  class WordExtractor {
    open(path: string): Promise<ExtractedWordDocument>
  }

  export default WordExtractor
}
