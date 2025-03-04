export default interface ScoringDetails {
  [key: string]: {
    Score: {
      Staked: string
      Restaked: string
      Running: string
      Share: string
    }
    Rating: string
    Reward: {
      Hodler: string
      Operator: string
    }
  }
}
