import { sdk } from '../sdk'
import { showAccessPassword } from './show-access-password'

export const actions = sdk.Actions.of().addAction(showAccessPassword)
