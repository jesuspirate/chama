import { sdk } from '../sdk'
import { walletStatus } from './walletStatus'

export const actions = sdk.Actions.of().addAction(walletStatus)
