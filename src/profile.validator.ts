import { Profile } from './profile';

export class ProfileValidator {

    private readonly profile: Profile

    constructor(profile: Profile) {
        this.profile = profile
    }

    validate() {
        this.clean()

        if (!this.profile.input) throw new Error("Missing 'input' in profile")
        if (!this.profile.output) throw new Error("Missing 'output' in profile")
        if (!this.profile.input.include && !this.profile.input.exclude) throw new Error("Missing 'input.include' or 'input.exclude' in profile, all files are excluded by default")
        if (!this.profile.output.mappings || this.profile.output.mappings.length === 0) throw new Error("No 'output.mappings' defined")
        if (this.profile.output.mappings.some(m => !m.output)) throw new Error("'output' must be defined for each 'mappings'")
    }

    private clean() {
        // Remove 'mappings' where 'skip === true'
        this.profile.output.mappings = this.profile.output.mappings.filter(m => !m.skip)

        // Remove 'mappings[*].options' where 'skip === true'
        this.profile.output.mappings.filter(m => m.options && m.options.length > 0).forEach(m => m.options = m.options.filter(o => !o.skip))
    }
}